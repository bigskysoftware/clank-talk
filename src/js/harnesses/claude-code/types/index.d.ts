// the values the /taint pane keeps; see hooks/register.tsx
export type TaintInput = {
  ref: string
  time: string
  status: string
  approved: boolean
  size: string
  judge: string
  source: string
}

export type TaintView = {
  taint: string
  warnings: string[]
  inputs: TaintInput[]
  selected: string | null
  text: string
  top: number
  showApproved: boolean
  page: boolean
  message: string
}

declare module 'claude-code' {
  interface PluginState {
    'clank-talk': { view: Shaped<TaintView> }
  }
}
