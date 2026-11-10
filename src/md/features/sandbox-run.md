# Sandbox for run

Approved. Code: `src/js/sandbox.js` (the profile, the bwrap arguments and the self-test), and the "sandbox" section of `src/js/runtime.js`.

`run` and `start` are where the ClankTalk sandbox ends: a program can do anything the user can do. `npm test` runs project code, and the agent can write that code. The OS sandbox puts a limit on such programs.

## The main rule

- Approved: the sandbox is never silent. If ClankTalk cannot prove that the sandbox works on this OS, a sandboxed `run` is an error, and the program does not run. ClankTalk never runs it without the sandbox.

## Syntax

- Approved: on each `run` and `start`: `run 'npm test' in a sandbox`, `start 'npm run dev' as 'site' in a sandbox`.
- Approved: options after `with`: `network`, `local network`, `writes to <path>`, `reads of <path>`.
- Approved (built): `with local network` allows connections to and from localhost only. On macOS, the program can reach servers on the host's localhost. On Linux, it gets its own loopback: it can use servers that it starts, but not servers on the host. For example: `run 'npm install' in a sandbox with network`, `run 'mvn test' in a sandbox with writes to '~/.m2'`, `run 'gh pr list' in a sandbox with network, reads of '~/.config/gh'`.
- Approved (built): `in a sandbox` comes after the arguments, and before `within`: `run 'npm' with 'test' in a sandbox within 10 minutes`. `in` is claimed while the arguments parse (the follows set).
- Approved (built): a `run` with no `in a sandbox` works as now. A hook can require a sandbox: the step's `sandbox` is null without one.
- Approved (built): each sandboxed run gets its own temp folder (`TMPDIR`), removed after the run, or when a process ends.
- Proposed (built): `HOME` is a fresh folder in that temp folder. The allowed parts of the real home (the caches, `reads of`, `writes to`) are linked into it. Why: many programs look for config in the home folder. A missing file is fine for them, but a blocked file is a fatal error (git: `unable to access '~/.gitconfig'`). Thus secrets such as `~/.npmrc` are not even visible.
- Proposed (built): a sandboxed program gets `CLANK_TALK_SANDBOXED=1`. A sandbox cannot start inside another, so a ClankTalk inside the sandbox fails at once with a clear reason.
- Tested: this repo's `npm test` passes in a sandbox `with local network` (the fetch tests need local servers). The real-sandbox tests skip there.

## What the sandbox allows

- Approved (built): writes only inside the project, and never to `.git/`, `.talk` files, `@/talk/`, or hidden files and folders (the same rules as scripts, plus what `allow changes to` allows). Also the program's own temp folder.
- Approved (built): `allow changes to` opens only hidden paths. `.git/`, `.talk` files and `@/talk/` stay closed inside an allowed folder too, such as `.github/x.talk` under `allow changes to @/.github/`. On macOS, the profile denies them after the allows, because the last rule that matches wins.
- Approved: no home folder by default. A program can read:
  - system folders: `/usr`, `/bin`, `/sbin`, `/System`, `/Library`, `/etc`, `/opt`, `/dev`, and its own temp folder
  - the project
  - the install folder of the program that runs, found on `PATH`: for example `~/.nvm/versions/node/v22` for `node` or `npm`
  - Approved (built): the install folder is never `/`, the home folder, or a folder above it. Then it is only the program's own folder: `/bin` for `/bin/sh`, `~/bin` for `~/bin/tool`. Why: `/bin/sh` gave `/`, so a sandboxed shell could read the whole disk.
  - the cache folders of known tools, read only: `~/.npm`, `~/.cache`, `~/.m2/repository`, `~/.gradle/caches`, `~/.gradle/wrapper`, `~/.cargo/registry`, `~/.rustup/toolchains`, `~/go/pkg`, `~/Library/Caches`
  - what `with reads of` adds
- Approved: secret files are blocked even inside an allowed folder: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.netrc`, `~/.docker`, `~/.kube`, `~/.npmrc`, `~/.m2/settings.xml`, `~/.gradle/gradle.properties`, `~/.cargo/credentials`, `~/.cargo/credentials.toml`, `~/.pypirc`, and `.env` files in the project.
- Why: a sandboxed program can write what it reads into the project, and the agent can read the project. Thus a wide read leaks to the agent, even with no network.
- Approved (built): no network. With `in a sandbox`, a `start` can still listen on localhost, so a dev server works.
- Approved (built): the limits hold for every child process, because the OS applies them to the process tree.

## Where it works

- Approved: macOS: `sandbox-exec` with a generated profile. Apple marks it deprecated, but it ships with macOS. Check it for each macOS version.
- Approved: Linux: `bubblewrap` (`bwrap`), if it is installed. If not, the error says to install it. We test on macOS only, and ask Linux users to test.
- Approved (built, not tested on Linux): bwrap hides a secret folder with an empty folder (`--tmpfs`) and a secret file, such as `.env` or `.netrc`, with `/dev/null` (`--ro-bind /dev/null`), because `--tmpfs` needs a folder. A secret that is not there is left out.
- Approved: Windows and other OSs: an error.

## Proof before trust

- Approved (built): at the first sandboxed `run` in a session, ClankTalk runs a self-test in the sandbox: it tries to write outside the project, to write `.git/`, to read `~/.ssh`, and to open a network connection. If any of these works, the sandbox is broken: the run is an error, and so is each later sandboxed run in the session.

## Limits

- A sandbox profile cannot stop a program from using a lot of CPU or memory.
- macOS: the profile allows `mach-lookup`, so a program can talk to system services. Many tools need this. Without network, data still cannot leave through the network stack. This is a known gap in this kind of profile.
- macOS: `file-read-metadata` is allowed everywhere, so a program can see that a file exists, and its size, but not its content.
- Linux: hidden files, `.talk` files and `@/talk` are read only only if they exist when the program starts, and only at the top of the project. A program can make a new hidden file, or change one deeper in the tree. Landlock can close this later.
- Linux: with no network, a server in the sandbox has its own network, so the host cannot reach it. A sandboxed `start` on Linux needs `with network`.
- Tested on macOS only (Darwin 27, Node 26). Linux needs testers.
