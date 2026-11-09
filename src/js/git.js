// Hardened git: what makes a git call safe, with no language parts
// See src/md/features/git.md.
//
// Git runs programs from its config (hooks, fsmonitor, pager, filters, ...).
// The agent cannot write .git/, but a "run" program can, so each call:
//   1. checks the repo config, and refuses keys that run programs
//   2. turns those keys off with -c, as a second guard
//   3. starts git with a clean environment

// every hook event, from "git help hooks" (git 2.56)
// core.hooksPath and --no-verify do not stop config hooks (hook.<name>.command),
// so each event is turned off one by one
export const HOOK_EVENTS = [
  "applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit",
  "prepare-commit-msg", "commit-msg", "post-commit", "pre-rebase", "post-checkout", "post-merge",
  "pre-push", "pre-receive", "update", "proc-receive", "post-receive", "post-update",
  "reference-transaction", "push-to-checkout", "pre-auto-gc", "post-rewrite", "sendemail-validate",
  "fsmonitor-watchman", "post-index-change",
];

// repo config keys that run a program, or point git at other files; all lowercase
const DANGEROUS_KEYS = [
  "core.hookspath", "core.fsmonitor", "core.pager", "core.editor", "sequence.editor",
  "core.sshcommand", "core.gitproxy", "core.askpass", "core.alternaterefscommand",
  "core.worktree", "core.attributesfile", "credential.helper", "diff.external",
  "gpg.program", "gpg.ssh.defaultkeycommand", "uploadpack.packobjectshook", "gc.recentobjectshook",
];

// sections where any key can run a program, or bring in more config
const DANGEROUS_SECTIONS = [
  "hook", "alias", "pager", "filter", "difftool", "mergetool", "guitool", "browser", "man",
  "include", "includeif",
];

// section.<subsection>.key: these keys run a program for any subsection
const DANGEROUS_SUBSECTION_KEYS = [
  "diff.command", "diff.textconv", "gpg.program", "credential.helper",
  "remote.uploadpack", "remote.receivepack", "remote.proxy", "url.insteadof", "url.pushinsteadof",
];

/**
 * The repo config keys that make a git call unsafe.
 * @param {string} configList  the output of "git config list --show-scope"
 * @returns {string[]} each refused setting, as "key=value"
 */
export function unsafeConfig(configList) {
  const refused = [];
  for (const line of configList.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab === -1) {
      continue;
    }
    // global and system config is the user's own; only repo config is checked
    const scope = line.slice(0, tab);
    if (scope !== "local" && scope !== "worktree") {
      continue;
    }
    const setting = line.slice(tab + 1);
    const equals = setting.indexOf("=");
    const key = (equals === -1 ? setting : setting.slice(0, equals)).toLowerCase();
    const value = equals === -1 ? "" : setting.slice(equals + 1);
    if (isDangerous(key, value)) {
      refused.push(setting);
    }
  }
  return refused;
}

function isDangerous(key, value) {
  if (DANGEROUS_KEYS.includes(key)) {
    return true;
  }
  const parts = key.split(".");
  const section = parts[0];
  const name = parts[parts.length - 1];
  if (DANGEROUS_SECTIONS.includes(section)) {
    return true;
  }
  // diff.<driver>.textconv, remote.<name>.uploadpack, ...
  if (parts.length > 2 && DANGEROUS_SUBSECTION_KEYS.includes(section + "." + name)) {
    return true;
  }
  // a remote URL with ext:: runs a program
  if (section === "remote" && name === "url" && value.startsWith("ext::")) {
    return true;
  }
  return false;
}

/**
 * The arguments that go before every git operation: each one turns off a way to run a program.
 * Operations add their own guards, such as --no-ext-diff and --no-verify.
 */
export function guardArgs() {
  const args = [
    "--no-pager",
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "core.editor=false",
    "-c", "sequence.editor=false",
    "-c", "protocol.ext.allow=never",
    "-c", "gc.auto=0",
    "-c", "credential.helper=",
  ];
  for (const event of HOOK_EVENTS) {
    args.push("-c", "hook." + event + ".enabled=false");
  }
  return args;
}

/**
 * A clean environment for git: PATH and HOME only, so no GIT_* variable from outside
 * can change what git runs. GIT_TERMINAL_PROMPT=0 stops git from asking for a password.
 */
export function gitEnv(processEnv) {
  const env = { GIT_TERMINAL_PROMPT: "0" };
  if (processEnv.PATH !== undefined) {
    env.PATH = processEnv.PATH;
  }
  if (processEnv.HOME !== undefined) {
    env.HOME = processEnv.HOME;
  }
  return env;
}

// letters, digits, - _ / . ; not first -, no "..", no ending ".lock" or "/"
const BRANCH_NAME = /^[A-Za-z0-9_][A-Za-z0-9_\-\/.]*$/;

/**
 * True if the name is safe as a branch name argument.
 */
export function isSafeBranchName(name) {
  if (typeof name !== "string" || !BRANCH_NAME.test(name)) {
    return false;
  }
  if (name.includes("..") || name.includes("//") || name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock")) {
    return false;
  }
  return true;
}

// a commit id or a ref such as HEAD~2: letters, digits, ~ ^ and the branch name characters
const COMMIT_NAME = /^[A-Za-z0-9_][A-Za-z0-9_\-\/.~^]*$/;

/**
 * True if the text is safe as a commit argument for git show.
 */
export function isSafeCommitName(name) {
  return typeof name === "string" && COMMIT_NAME.test(name) && !name.includes("..");
}
