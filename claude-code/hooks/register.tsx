import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TaintInput, TaintView } from '../types'

// /taint: a pane to review the untrusted inputs; see src/md/features/taint.md
// It runs the ClankTalk command line (npx clank-talk taint ...) for each step, so the rules stay there.
// Only the person's own Enter opens it, and only the person presses its keys: the model cannot approve.

const PANE = 'clank-taint'
// the most rows of the list that the pane shows at once
const LIST_ROWS = 8
// the text rows that the last drawing showed: h and l scroll by half of it
let textRows = 20
const EMPTY: TaintView = { taint: 'on', warnings: [], inputs: [], selected: null, text: '', top: 0, showApproved: false, page: true, message: '' }
// change the tag when TaintView changes: it declines what an earlier version stored
const view = atom({ plugin: 'clank-talk', key: 'view' } as const, EMPTY, { shape: 'taint-view-3' })

// ClankTalk's questions in Claude Code's own question dialog; see src/md/features/ask.md
//
// The ClankTalk MCP server asks with an elicitation. For 2 to 4 choices, its schema
// carries "x-clank": a one-time token and a local answer URL. This mod asks the human
// in the question dialog, posts the answer there, and declines the built-in form.
// The model never sees the elicitation, so it cannot get the token.

type Choice = { const: string; title?: string }
type Clank = { token: string; url: string }
type Field = { type?: string; oneOf?: Choice[]; items?: { anyOf?: Choice[] } }

// the answer URL must be the ClankTalk server on this machine
const ANSWER_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/answer$/

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'taint', description: 'Review and approve the untrusted inputs of this ClankTalk project' })
    await $.command.register({ name: 'clank-talk', description: 'ClankTalk only: on, off, or show which tools are allowed' })
    return next(e)
  })

  // ClankTalk only: while it is on, the agent can use clank_talk and the allowed tools, and nothing else
  // see src/md/features/harness-tools.md
  on('tool.call', async ($, e, next) => {
    if (CLANK_TALK_TOOL.test(e.tool) || BUILT_IN.includes(e.tool)) {
      return next(e)
    }
    const root = await $.session.root()
    const harness = await projectHarness($, root)
    if (!(await mode($, root, harness)).on || toolAllowed(e.tool, harness.allowed)) {
      return next(e)
    }
    return { deny: 'ClankTalk is on in this project, so ' + e.tool + ' is blocked. Do the work in a ClankTalk script with the clank_talk tool. To allow the tool, the human can add a line to AGENTS.talk: allow harness tools ' + e.tool }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'clank-talk: the ClankTalk guard failed, so ' + e.tool + ' is blocked' }))

  // /clank-talk on | off, or a report with no argument
  on('command.run', { command: 'clank-talk' }, async ($, e) => {
    const root = await $.session.root()
    cached = null
    const harness = await projectHarness($, root)
    const arg = e.args.trim()
    if (arg === 'on' || arg === 'off') {
      // only the person's own Enter changes it; never the model or another plugin
      if (e.origin.kind !== 'composer') {
        return { text: 'Only the person at the terminal can turn ClankTalk on or off.' }
      }
      if (arg === 'off' && harness.required) {
        return { text: 'AGENTS.talk has require clank-talk, so ClankTalk stays on. To turn it off, remove that line.' }
      }
      switched = arg
      return { text: 'ClankTalk is ' + arg + ' for this session.' + (arg === 'on' ? ' Other tools are blocked; /clank-talk shows which.' : '') }
    }
    if (arg !== '') {
      return { text: 'Usage: /clank-talk [on | off]' }
    }
    const state = await mode($, root, harness)
    const names = (await $.tool.list()).map(tool => tool.name)
    const allowed = names.filter(name => CLANK_TALK_TOOL.test(name) || BUILT_IN.includes(name) || toolAllowed(name, harness.allowed))
    const blocked = names.filter(name => !allowed.includes(name))
    const lines = [
      'ClankTalk: ' + (state.on ? 'on' : 'off') + ' (' + state.why + ')',
      'allowed: ' + (allowed.length === 0 ? 'none' : grouped(allowed)),
      (state.on ? 'blocked: ' : 'blocked when on: ') + (blocked.length === 0 ? 'none' : grouped(blocked) + ' (' + blocked.length + ' in all)'),
    ]
    if (harness.allowed.length > 0) {
      lines.push('AGENTS.talk allows: ' + harness.allowed.join(', '))
    }
    for (const error of harness.errors) {
      lines.push('AGENTS.talk error: ' + error)
    }
    return { text: lines.join('\n') }
  })

  on('command.run', { command: 'taint' }, async ($, e) => {
    // only the person's own Enter opens the review; never the model, a plugin, or a channel the engine cannot attest
    if (e.origin.kind !== 'composer') {
      return { text: 'Only the person at the terminal can open /taint.' }
    }
    await load($, null)
    const opened = await $.ui.open({ id: PANE, title: 'Taint review', focus: true, closeOnEscape: true })
    if (!opened.isPlaced) {
      return { text: 'The taint review could not open: ' + opened.reason + '. Use: npx clank-talk taint --tui' }
    }
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const state = await read($, view)
    const shown = visible(state)
    const waiting = state.inputs.filter(input => !input.approved).length
    const current = shown.find(input => input.ref === state.selected) ?? null
    const lines = state.text.split('\n')
    const width = Math.max(20, e.props.bodyColumns ?? 60)
    const digits = String(lines.length).length
    // the keys that apply now: [key, label, action]
    const keys: [string, string, () => void][] = []
    const add = (hotkey: string, label: string, run: () => void, show = true) => void (show && keys.push([hotkey, label, run]))
    const long = current !== null && lines.length > 1
    add('j', 'next', () => void move($, 1), shown.length > 1)
    add('k', 'previous', () => void move($, -1), shown.length > 1)
    add('g', 'first', () => void move($, -shown.length), shown.length > 1)
    add('h', 'text up', () => void scroll($, -1), long)
    add('l', 'text down', () => void scroll($, 1), long)
    add('t', 'text top', () => void scroll($, -Infinity), long)
    add('b', 'text bottom', () => void scroll($, Infinity), long)
    add('a', 'approve', () => void act($, ['approve', current!.ref], 'Approved ' + current!.ref), current !== null && !current.approved)
    add('u', 'unapprove', () => void act($, ['unapprove', current!.ref], 'Unapproved ' + current!.ref), current !== null && current.approved)
    add('e', 'approve all', () => void act($, ['approve', '--all'], 'Approved all inputs'), waiting > 0)
    add('m', state.page ? 'raw' : 'text view', () => void toggle($, 'page'), current !== null)
    add('o', 'open in browser', () => void openPage($, current!.ref), current !== null)
    add('s', state.showApproved ? 'hide approved' : 'show approved', () => void toggle($, 'showApproved'))
    add('r', 'refresh', () => void load($, state.selected))
    add('q', 'close', () => void $.ui.close({ id: PANE }))
    // the rows the keys take at this width: each is "k: label", with 2 spaces between
    let keyRows = 1
    let used = 0
    for (const [, label] of keys) {
      const size = label.length + 3
      if (used > 0 && used + 2 + size > width) {
        keyRows++
        used = 0
      }
      used += (used > 0 ? 2 : 0) + size
    }
    // the text gets the rows that the rest leaves: header, keys, message, gap, list, gap, info, rule
    const listRows = Math.min(LIST_ROWS, shown.length) + (shown.length > LIST_ROWS ? 1 : 0)
    const rest = 1 + keyRows + (state.message !== '' ? 1 : 0) + state.warnings.length + 1 + listRows + 1 + 1 + 1
    const room = Math.max(5, (e.props.scroll?.bodyRows ?? 30) - rest)
    // a long line wraps and takes more rows, so count them
    const top = Math.max(0, Math.min(state.top, lines.length - 1))
    let count = 0
    let rowsLeft = room
    while (top + count < lines.length && rowsLeft > 0) {
      rowsLeft -= Math.max(1, Math.ceil((digits + 1 + (lines[top + count] ?? "").length) / width))
      if (rowsLeft < 0 && count > 0) {
        break
      }
      count++
    }
    textRows = Math.max(1, count)
    const oneSession = new Set(shown.map(input => input.ref.slice(0, input.ref.lastIndexOf('/')))).size <= 1
    // a window of the list around the current input, so the text stays on the screen
    const at = Math.max(0, shown.findIndex(input => input.ref === state.selected))
    const first = Math.max(0, Math.min(at - Math.floor(LIST_ROWS / 2), shown.length - LIST_ROWS))
    const refWidth = Math.max(0, ...shown.map(input => (oneSession ? 1 + input.ref.length - input.ref.lastIndexOf('/') - 1 : input.ref.length)))
    return (
      <Box flexDirection="column">
        <Text>
          <Text bold color={waiting === 0 ? 'green' : 'yellow'}>{waiting === 0 ? 'Nothing to approve' : waiting + ' not approved'}</Text>
          <Text dimColor>{(shown.length > 1 ? '   ' + (at + 1) + ' of ' + shown.length : '') + '   taint ' + state.taint + (state.showApproved ? '   approved shown' : '')}</Text>
        </Text>
        <Box flexWrap="wrap" columnGap={2}>
          {keys.map(([hotkey, label, run]) => <Button plain hotkey={hotkey} onPress={run}>{label}</Button>)}
        </Box>
        {state.message !== '' && <Text color="cyan">{state.message}</Text>}
        {state.warnings.map(warning => <Text color="red">{warning}</Text>)}
        {shown.length === 0 && <Text dimColor>{state.showApproved ? 'No untrusted inputs.' : 'Press s to show the approved inputs.'}</Text>}
        <Text> </Text>
        {first > 0 && <Text dimColor>{'  ... ' + first + ' more above'}</Text>}
        {shown.slice(first, first + LIST_ROWS).map(input => {
          // one row each: the ref (only the number when all inputs are from one session), the status, and the source cut to fit
          const ref = oneSession ? '#' + input.ref.slice(input.ref.lastIndexOf('/') + 1) : input.ref
          const head = (input.ref === state.selected ? '> ' : '  ') + ref.padEnd(refWidth) + '  '
          const status = input.status.padEnd(9)
          return (
            <Button key={input.ref} plain onPress={() => void load($, input.ref)}>
              {head}
              <Text color={input.approved ? 'green' : 'yellow'}>{status}</Text>
              <Text dimColor>{cut(input.source, width - head.length - status.length)}</Text>
            </Button>
          )
        })}
        {first + LIST_ROWS < shown.length && <Text dimColor>{'  ... ' + (shown.length - first - LIST_ROWS) + ' more below'}</Text>}
        {current !== null && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>{cut([current.time, current.size, current.judge === '-' ? '' : 'judge: ' + current.judge, state.page ? 'text view' : 'raw', 'lines ' + (top + 1) + '-' + Math.min(lines.length, top + textRows) + '/' + lines.length].filter(part => part !== '').join('  '), width)}</Text>
            <Text dimColor>{'─'.repeat(width)}</Text>
            {lines.slice(top, top + textRows).map((line, index) => (
              <Text>
                <Text dimColor>{String(top + index + 1).padStart(digits) + ' '}</Text>
                {line === '' ? ' ' : line}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })

  on('classic.Elicitation', async ($, e, next) => {
    const schema = (e.requested_schema ?? {}) as Record<string, unknown>
    const clank = schema['x-clank'] as Clank | undefined
    if (!clank || typeof clank.token !== 'string' || typeof clank.url !== 'string' || !ANSWER_URL.test(clank.url)) {
      return next(e)
    }
    const field = ((schema.properties ?? {}) as Record<string, Field>).answer ?? {}
    const many = field.type === 'array'
    const choices = (many ? field.items?.anyOf : field.oneOf) ?? []
    const labels = choices.map(choice => choice.title ?? choice.const)
    if (labels.length < 2 || labels.length > 4) {
      return next(e)
    }
    let answer: string | string[] | null = null
    try {
      const picked = await $.ui.ask(e.message.endsWith('?') ? e.message : e.message + '?', many ? { header: 'ClankTalk', options: labels, multiSelect: true } : { header: 'ClankTalk', options: labels })
      answer = many ? pickedLabels(picked, labels) : labels.includes(picked) ? picked : null
    } catch {
      // closed, "Chat about this", or no one to ask: no answer
      answer = null
    }
    const values = (list: string[]) => list.map(label => choices[labels.indexOf(label)]?.const ?? label)
    const body = JSON.stringify({ token: clank.token, answer: answer === null ? null : Array.isArray(answer) ? values(answer) : values([answer])[0] })
    await $.http.fetch(clank.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    return { block: 'Answered in the ClankTalk question dialog' }
  })
}

// the dialog joins several picks with ', '; a label can hold ', ' too, so join the parts back
// gives the labels in their order, or null when a part is not a label (text typed under "Other")
function pickedLabels(picked: string, labels: string[]): string[] | null {
  if (picked === '') {
    return []
  }
  const found: string[] = []
  let part = ''
  for (const piece of picked.split(', ')) {
    part = part === '' ? piece : part + ', ' + piece
    if (labels.includes(part)) {
      found.push(part)
      part = ''
    }
  }
  return part === '' ? labels.filter(label => found.includes(label)) : null
}

// text cut to fit a width, with ... at the end
function cut(text: string, width: number): string {
  return text.length <= width ? text : width <= 3 ? text.slice(0, Math.max(0, width)) : text.slice(0, width - 3) + '...'
}

// the inputs the list shows
function visible(state: TaintView): TaintInput[] {
  return state.inputs.filter(input => state.showApproved || !input.approved)
}

// j, k and g: move in the list, and read the text of the new input
async function move($: EngineInterface, by: number): Promise<void> {
  const state = await read($, view)
  const shown = visible(state)
  const at = Math.max(0, shown.findIndex(input => input.ref === state.selected))
  const next = shown[Math.min(shown.length - 1, Math.max(0, at + by))]
  if (next !== undefined) {
    await load($, next.ref)
  }
}

// h and l: scroll the text by half of what shows; t and b: the top and the bottom
async function scroll($: EngineInterface, direction: number): Promise<void> {
  const step = Math.max(1, Math.floor(textRows / 2))
  await update($, view, old => {
    const last = Math.max(0, old.text.split('\n').length - textRows)
    // a direction of Infinity goes to the end: t and b
    const top = Number.isFinite(direction) ? old.top + direction * step : direction > 0 ? last : 0
    return { ...old, top: Math.max(0, Math.min(last, top)) }
  })
}

// m and s: change the view, then read again
async function toggle($: EngineInterface, field: 'page' | 'showApproved'): Promise<void> {
  await update($, view, old => ({ ...old, [field]: !old[field] }))
  await load($, (await read($, view)).selected)
}

// o: a read-only page of the input in the browser
async function openPage($: EngineInterface, ref: string): Promise<void> {
  const ran = await cli($, ['show', '--html', ref])
  await update($, view, old => ({ ...old, message: ran.ok ? 'Opened in the browser: ' + ran.text.trim() : 'Failed: ' + ran.text.trim().slice(0, 300) }))
}

// run the ClankTalk command line in the project
async function cli($: EngineInterface, args: string[]): Promise<{ ok: boolean; text: string }> {
  const cwd = await $.session.root()
  const result = await $.process.run([...(await command($, cwd)), 'taint', ...args], { cwd })
  return { ok: result.exitCode === 0, text: result.exitCode === 0 ? result.stdout : result.stderr || result.stdout }
}

// ClankTalk's own tool, under any MCP server name: mcp__clank-talk__clank_talk
const CLANK_TALK_TOOL = /^mcp__.+__clank_talk$/
// tools that only talk to the person or plan: always allowed
const BUILT_IN = ['AskUserQuestion', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TodoWrite', 'ToolSearch', 'EnterPlanMode', 'ExitPlanMode']

type Harness = { agentsTalk: boolean; required: boolean; allowed: string[]; errors: string[] }
// the project's settings, read again when AGENTS.talk changes
let cached: { root: string; stamp: number; harness: Harness } | null = null

// require clank-talk and allow harness tools, from AGENTS.talk, through the command line
// if it cannot be read, a project with an AGENTS.talk stays on with no extra tools: the guard fails closed
async function projectHarness($: EngineInterface, root: string): Promise<Harness> {
  const file = root + '/AGENTS.talk'
  const stamp = (await $.fs.exists(file)) ? (await $.fs.stat(file)).mtimeMs : 0
  if (cached !== null && cached.root === root && cached.stamp === stamp) {
    return cached.harness
  }
  const ran = await $.process.run([...(await command($, root)), 'harness', '--json'], { cwd: root })
  let harness: Harness
  try {
    harness = JSON.parse(ran.stdout) as Harness
  } catch {
    harness = { agentsTalk: stamp !== 0, required: false, allowed: [], errors: ['clank-talk harness failed: ' + (ran.stderr || ran.stdout).trim().slice(0, 200)] }
  }
  cached = { root, stamp, harness }
  return harness
}

// /clank-talk on or off, for this session only: nothing is kept
let switched: 'on' | 'off' | null = null

// on or off, and why: require clank-talk wins, then /clank-talk on or off, then on when there is an AGENTS.talk
async function mode($: EngineInterface, root: string, harness: Harness): Promise<{ on: boolean; why: string }> {
  if (harness.required) {
    return { on: true, why: 'required by AGENTS.talk' }
  }
  const saved = switched
  if (saved === 'on' || saved === 'off') {
    return { on: saved === 'on', why: 'from /clank-talk ' + saved }
  }
  return harness.agentsTalk ? { on: true, why: 'the project has an AGENTS.talk' } : { on: false, why: 'the project has no AGENTS.talk' }
}

// tool names in short: built-in tools by name, then MCP tools by server, as mcp__idea__* (90)
function grouped(names: string[]): string {
  const servers = new Map<string, number>()
  const plain: string[] = []
  for (const name of names) {
    const match = /^mcp__(.+?)__/.exec(name)
    if (match === null) {
      plain.push(name)
    } else {
      servers.set(match[1] ?? '', (servers.get(match[1] ?? '') ?? 0) + 1)
    }
  }
  const mcp = [...servers].map(([server, count]) => (count === 1 ? names.find(name => name.startsWith('mcp__' + server + '__')) ?? '' : 'mcp__' + server + '__* (' + count + ')'))
  return [...plain, ...mcp].join(', ')
}

// a name from allow harness tools: the same name, or a pattern where * is any text
function toolAllowed(name: string, patterns: string[]): boolean {
  return patterns.some(pattern => (pattern.includes('*') ? new RegExp('^' + pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(name) : pattern === name))
}

// the ClankTalk command line: the project's own when the project is ClankTalk itself, else npx,
// which takes the project's installed copy first
async function command($: EngineInterface, root: string): Promise<string[]> {
  try {
    const pkg = JSON.parse(String(await $.fs.read(root + '/package.json'))) as { name?: string }
    if (pkg.name === 'clank-talk' && (await $.fs.exists(root + '/bin/clank-talk.js'))) {
      return ['node', root + '/bin/clank-talk.js']
    }
  } catch {
    // no package.json, or one that is not JSON: use npx
  }
  return ['npx', '--yes', 'clank-talk']
}

// read the inputs again, and the text of the selected one
async function load($: EngineInterface, selected: string | null): Promise<void> {
  const listed = await cli($, ['--json'])
  if (!listed.ok) {
    await update($, view, old => ({ ...old, message: 'clank-talk taint failed: ' + listed.text.trim().slice(0, 300) }))
    return
  }
  const data = JSON.parse(listed.text) as { taint: string; warnings: string[]; inputs: TaintInput[] }
  const state = await read($, view)
  const shown = visible({ ...state, inputs: data.inputs })
  const pick = shown.some(input => input.ref === selected) ? selected : shown[0]?.ref ?? null
  const text = pick === null ? '' : (await cli($, ['show', state.page ? '--page' : '--body', pick])).text.replace(/\n$/, '')
  // another input, or another view of it, starts at the top
  await update($, view, old => ({ ...old, taint: data.taint, warnings: data.warnings, inputs: data.inputs, selected: pick, text, top: pick === old.selected && text === old.text ? old.top : 0 }))
}

// approve or unapprove, then read the inputs again
async function act($: EngineInterface, args: string[], done: string): Promise<void> {
  const ran = await cli($, args)
  const state = await read($, view)
  await load($, state.selected)
  await update($, view, old => ({ ...old, message: ran.ok ? done : 'Failed: ' + ran.text.trim().slice(0, 300) }))
  // the last approval closes the pane: nothing is left to review
  const after = await read($, view)
  if (ran.ok && args[0] === 'approve' && after.inputs.every(input => input.approved)) {
    await update($, view, old => ({ ...old, message: '' }))
    $.ui.toast('All untrusted inputs are approved')
    await $.ui.close({ id: PANE })
  }
}
