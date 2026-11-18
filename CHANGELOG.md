# Changelog

## [0.1.4] - 2026-11-18

* [Added](https://github.com/bigskysoftware/clank-talk/commit/eeee775) `CLANK_TALK=on|off` and `CLANK_TALK_ALLOW` env vars, for apps that start agents, such as mr-klanky
* [Added](https://github.com/bigskysoftware/clank-talk/commit/eeee775) `npx clank-talk taint add`: an app that carries text between agents passes the taint along
* [Added](https://github.com/bigskysoftware/clank-talk/commit/97f71f9) help in three levels: `help`, `help <area>`, `help <command>`, with the closest topics for an unknown word
* [Added](https://github.com/bigskysoftware/clank-talk/commit/c10200c) `because`, `lines <n> after <line>`, `list` as a value, and examples on parse errors
* [Added](https://github.com/bigskysoftware/clank-talk/commit/b7f7f9b) host tools: description, params, untrusted, and effects (reads, changes with undo, sends)
* [Updated](https://github.com/bigskysoftware/clank-talk/commit/b7b3509) a text-block `replace` must match one place; `replace every` replaces all
* [Updated](https://github.com/bigskysoftware/clank-talk/commit/0f04b18) `.env` files follow the dotenv rules
* [Updated](https://github.com/bigskysoftware/clank-talk/commit/5a31c72) pi exports `askFor` for other pi hosts; a clearer error when a host answers a form with text
* Fixed a host tool with a `reads` effect could read a `.env` file, or a link out of the root
* Fixed an allowed harness edit tool could change a hidden file, such as `.git/hooks` or `.claude/settings.json`; now `allow changes to` must name it, as for scripts
* Fixed in pi and opencode, a root in another letter case got past the protected paths of allowed edit tools
* [Fixed](https://github.com/bigskysoftware/clank-talk/commit/e197e56) allowed harness edit tools could change `talk/`, or protected paths in another letter case

## [0.1.3] - 2026-11-12

* [Added](https://github.com/bigskysoftware/clank-talk/commit/1cb1cdb) a Claude Code plugin: `/clank-talk on|off` blocks the other tools, `/taint` reviews untrusted inputs, and ClankTalk's questions use Claude Code's own dialog. Install: `/plugin install clank-talk --marketplace bigskysoftware/clank-talk`
* [Added](https://github.com/bigskysoftware/clank-talk/commit/17e9c21) an experimental opencode V2 plugin
* [Added](https://github.com/bigskysoftware/clank-talk/commit/1cb1cdb) `require clank-talk` and `allow harness tools ...` in AGENTS.talk; ClankTalk is on by default in a project with an AGENTS.talk
* [Added](https://github.com/bigskysoftware/clank-talk/commit/8a80808) an audit record for each allowed harness tool; `allow untrusted harness tools ...` makes their results taint
* [Added](https://github.com/bigskysoftware/clank-talk/commit/0346bce) `npx clank-talk taint --tui`, a full-screen review with vi keys, marks, a page view for HTML and a line judge
* [Added](https://github.com/bigskysoftware/clank-talk/commit/8f6b72b) `/taint` in pi, and `/taint clear` to approve all inputs
* [Added](https://github.com/bigskysoftware/clank-talk/commit/184c8fc) `ask` choices with descriptions (`'staging: the test site'`), `with any of` for several picks, and the first choice as the default
* [Added](https://github.com/bigskysoftware/clank-talk/commit/184c8fc) `taint show --html` opens a read-only page of an input in the browser
* [Added](https://github.com/bigskysoftware/clank-talk/commit/7137c11) `npx clank-talk status-line` for the Claude Code status line
* [Added](https://github.com/bigskysoftware/clank-talk/commit/3f6d353) `trust fetch from <host or URL>`: text from it does not taint; a policy can `deny trust`
* [Updated](https://github.com/bigskysoftware/clank-talk/commit/1e5b7a1) `trust fetch from` also allows the host; `'*'` trusts or allows every public host, with a warning
* [Updated](https://github.com/bigskysoftware/clank-talk/commit/2421d60) the fetch host question: yes once, yes for this session, or no
* [Added](https://github.com/bigskysoftware/clank-talk/pull/1) Codex install instructions (thanks @Molkars)
* [Fixed](https://github.com/bigskysoftware/clank-talk/commit/4d7c362) an allowed write or edit tool could change `.talk/` or `.talk` files

## [0.1.2] - 2026-11-11

* [Updated](https://github.com/bigskysoftware/clank-talk/commit/508aa39) an untrusted input is stored once per source and text
* [Updated](https://github.com/bigskysoftware/clank-talk/commit/508aa39) `wait until` backs off, and takes `every <duration>`

## [0.1.1] - 2026-11-10

* [Added](https://github.com/bigskysoftware/clank-talk/commit/1f41062) `git push tag`, `add <value> to <list>`, `check`, and `does not start with`
* [Added](https://github.com/bigskysoftware/clank-talk/commit/1f41062) `reads of` opens a named secret path to a sandboxed run
* [Updated](https://github.com/bigskysoftware/clank-talk/commit/1f41062) `git commit` takes files with commas, and errors are clearer
* [Fixed](https://github.com/bigskysoftware/clank-talk/commit/1f41062) a tool name could be a command word

## [0.1.0] - 2026-11-10

* Initial release