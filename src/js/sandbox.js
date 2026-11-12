// OS sandbox for run and start, with no language parts
// See src/md/features/sandbox-run.md.
//
// macOS: sandbox-exec with a generated profile. Linux: bubblewrap (bwrap).
// Other OSs: no sandbox, so a sandboxed run is an error. Never a silent fallback.

import fs from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import { spawn } from "node:child_process";

// system folders that programs need to start: binaries, libraries, certificates, time zones
const SYSTEM_READS = ["/usr", "/bin", "/sbin", "/System", "/Library", "/etc", "/private/etc", "/opt", "/dev", "/lib", "/lib64", "/var/db/timezone", "/private/var/db/timezone"];

// cache folders of known tools, in the home folder; read only
const CACHE_READS = [".npm", ".cache", ".m2/repository", ".gradle/caches", ".gradle/wrapper", ".cargo/registry", ".rustup/toolchains", "go/pkg", "Library/Caches"];

// secrets in the home folder: blocked even inside an allowed folder
const SECRETS = [".ssh", ".aws", ".gnupg", ".config/gh", ".netrc", ".docker", ".kube", ".npmrc", ".m2/settings.xml", ".gradle/gradle.properties", ".cargo/credentials", ".cargo/credentials.toml", ".pypirc"];

/**
 * Which sandbox this OS has: "macos", "linux", or null with the reason.
 * @returns {Promise<{ kind: string|null, reason: string }>}
 */
export async function sandboxKind(platform = process.platform, pathText = process.env.PATH || "", env = process.env) {
  // a sandbox cannot start inside another one
  if (env.CLANK_TALK_SANDBOXED === "1") {
    return { kind: null, reason: "this program already runs in a ClankTalk sandbox, and a sandbox cannot start inside another" };
  }
  if (platform === "darwin") {
    if (await isFile("/usr/bin/sandbox-exec")) {
      return { kind: "macos", reason: "" };
    }
    return { kind: null, reason: "sandbox-exec is missing from /usr/bin" };
  }
  if (platform === "linux") {
    if ((await findOnPath("bwrap", pathText)) !== null) {
      return { kind: "linux", reason: "" };
    }
    return { kind: null, reason: "bubblewrap is not installed. Install it, for example: apt install bubblewrap" };
  }
  return { kind: null, reason: "ClankTalk has no sandbox for " + platform + " yet" };
}

async function isFile(path) {
  try {
    return (await fs.stat(path)).isFile();
  } catch (err) {
    return false;
  }
}

// the full path of a program on PATH, or null
export async function findOnPath(program, pathText) {
  if (program.includes("/")) {
    return (await isFile(program)) ? nodePath.resolve(program) : null;
  }
  for (const dir of pathText.split(nodePath.delimiter)) {
    if (dir === "") {
      continue;
    }
    const candidate = nodePath.join(dir, program);
    if (await isFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * The install folders of a program: the folder above its bin/, as found on PATH and after symlinks.
 * ~/.nvm/versions/node/v22/bin/npm gives ~/.nvm/versions/node/v22.
 */
export async function installDirs(program, pathText, home = os.homedir()) {
  const found = await findOnPath(program, pathText);
  if (found === null) {
    return [];
  }
  const homes = [home, await realOrSame(home)];
  const dirs = [installDir(found, homes)];
  const real = await fs.realpath(found);
  const realDir = installDir(real, homes);
  if (!dirs.includes(realDir)) {
    dirs.push(realDir);
  }
  return dirs;
}

// the folder above bin/, but never / or the home folder or a folder above it:
// /bin/sh gives /bin, and ~/bin/tool gives ~/bin, so the program cannot read the whole disk or home
function installDir(file, homes) {
  const above = nodePath.dirname(nodePath.dirname(file));
  if (above === nodePath.parse(above).root || homes.some((home) => home === above || home.startsWith(above + nodePath.sep))) {
    return nodePath.dirname(file);
  }
  return above;
}

/**
 * Everything a sandbox needs to know, with real paths (after symlinks), because the OS checks real paths.
 * @param {Object} options
 * @param {string} options.root            the project root
 * @param {string} options.tmp             the program's own temp folder
 * @param {string[]} options.programDirs   install folders of the program
 * @param {string[]} [options.reads]       more paths to read ("with reads of")
 * @param {string[]} [options.writes]      more paths to write ("with writes to")
 * @param {string[]} [options.allowedChanges]  hidden paths that AGENTS.talk allows, relative to the root
 * @param {boolean} [options.network]      "with network"
 * @param {boolean} [options.localNetwork] "with local network": localhost only
 * @param {boolean} [options.listen]       a server may listen on localhost (start)
 */
export async function sandboxPlan(options) {
  const home = await realOrSame(os.homedir());
  const plan = {
    root: await realOrSame(options.root),
    tmp: await realOrSame(options.tmp),
    home,
    reads: [],
    writes: [],
    secrets: [],
    opened: [],
    allowedChanges: options.allowedChanges || [],
    network: Boolean(options.network),
    localNetwork: Boolean(options.localNetwork),
    listen: Boolean(options.listen),
  };
  for (const path of SYSTEM_READS) {
    plan.reads.push(path);
  }
  for (const path of options.programDirs || []) {
    plan.reads.push(await realOrSame(path));
  }
  for (const path of CACHE_READS) {
    plan.reads.push(nodePath.join(home, path));
  }
  const named = [];
  for (const path of options.reads || []) {
    const real = await realOrSame(expandHome(path, home));
    plan.reads.push(real);
    named.push({ path: real, write: false });
  }
  for (const path of options.writes || []) {
    const real = await realOrSame(expandHome(path, home));
    plan.writes.push(real);
    named.push({ path: real, write: true });
  }
  for (const path of SECRETS) {
    plan.secrets.push(nodePath.join(home, path));
  }
  // a "reads of" or "writes to" line that names a secret path, or a path inside one, opens that path,
  // because the human wrote it; a parent path, such as ~, does not open the secrets in it
  plan.opened = named.filter(({ path }) => plan.secrets.some((secret) => path === secret || path.startsWith(secret + "/")));
  for (const path of [plan.root, plan.tmp, home, ...plan.reads, ...plan.writes]) {
    checkPathText(path);
  }
  return plan;
}

function expandHome(path, home) {
  if (path === "~") {
    return home;
  }
  if (path.startsWith("~/")) {
    return nodePath.join(home, path.slice(2));
  }
  return nodePath.resolve(path);
}

async function realOrSame(path) {
  try {
    return await fs.realpath(path);
  } catch (err) {
    return nodePath.resolve(path);
  }
}

// a path goes into a profile as text, so it must not hold quotes, backslashes or line breaks
function checkPathText(path) {
  if (/["\\\n\r]/.test(path)) {
    throw new Error("A sandbox path cannot hold a quote, a backslash or a line break: " + path);
  }
}

// a path as an SBPL regex, with the special characters escaped
function regexText(path) {
  return path.replace(/[.*+?^${}()|[\]]/g, "\\$&");
}

/**
 * A fresh home folder for the program, in its temp folder: programs look for config there, and find none.
 * The allowed parts of the real home (caches, "reads of", "writes to") are linked in.
 * A blocked file in the real home is an error for many programs (git: ~/.gitconfig), but a missing one is fine.
 * @returns {Promise<string>} the new home folder, for HOME
 */
export async function makeHome(plan) {
  const fakeHome = nodePath.join(plan.tmp, "home");
  await fs.mkdir(fakeHome, { recursive: true });
  for (const path of [...plan.reads, ...plan.writes]) {
    if (!path.startsWith(plan.home + "/")) {
      continue;
    }
    try {
      await fs.access(path);
    } catch (err) {
      continue;
    }
    const link = nodePath.join(fakeHome, nodePath.relative(plan.home, path));
    await fs.mkdir(nodePath.dirname(link), { recursive: true });
    try {
      await fs.symlink(path, link);
    } catch (err) {
      // a link for a folder above this one is already there
    }
  }
  return fakeHome;
}

/**
 * The macOS sandbox profile (SBPL). Later rules win over earlier ones.
 */
export function macosProfile(plan) {
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow signal (target same-sandbox))",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow ipc-posix-shm)",
    "(allow file-read-metadata)",
    "(allow file-ioctl (subpath \"/dev\"))",
  ];
  const reads = ["(literal \"/\")", "(subpath \"" + plan.root + "\")", "(subpath \"" + plan.tmp + "\")"];
  for (const path of plan.reads) {
    reads.push("(subpath \"" + path + "\")");
  }
  lines.push("(allow file-read* " + reads.join(" ") + ")");

  const writes = ["(subpath \"" + plan.root + "\")", "(subpath \"" + plan.tmp + "\")", "(literal \"/dev/null\")", "(literal \"/dev/tty\")", "(regex #\"^/dev/fd/\")"];
  for (const path of plan.writes) {
    writes.push("(subpath \"" + path + "\")");
  }
  lines.push("(allow file-write* " + writes.join(" ") + ")");

  // the same rules as scripts: no hidden files in the project, except what "allow changes to" allows;
  // then, after the allows, because the last rule that matches wins: never .git, .talk files or @/talk
  const root = regexText(plan.root);
  lines.push("(deny file-write* (regex #\"^" + root + "/(.*/)?\\.[^/]*\"))");
  for (const path of plan.allowedChanges) {
    lines.push("(allow file-write* (subpath \"" + plan.root + "/" + path + "\"))");
  }
  lines.push("(deny file-write* (subpath \"" + plan.root + "/.git\") (subpath \"" + plan.root + "/talk\") (regex #\"^" + root + "/(.*/)?[^/]*\\.talk$\"))");

  // secrets, and .env files in the project, are never read
  const secrets = [];
  for (const path of plan.secrets) {
    secrets.push("(subpath \"" + path + "\")");
  }
  secrets.push("(regex #\"^" + root + "/(.*/)?\\.env\")");
  lines.push("(deny file-read* " + secrets.join(" ") + ")");
  // a secret path that AGENTS.talk names in "reads of" or "writes to": the last rule that matches wins
  for (const { path, write } of plan.opened || []) {
    lines.push("(allow file-read* (subpath \"" + path + "\"))");
    if (write) {
      lines.push("(allow file-write* (subpath \"" + path + "\"))");
    }
  }

  if (plan.network) {
    lines.push("(allow network*)");
  } else if (plan.listen || plan.localNetwork) {
    lines.push("(allow network-bind (local ip \"localhost:*\"))");
    lines.push("(allow network-inbound (local ip \"localhost:*\"))");
  }
  // with local network: also connect to localhost, and nothing else
  if (!plan.network && plan.localNetwork) {
    lines.push("(allow network-outbound (remote ip \"localhost:*\"))");
  }
  return lines.join("\n") + "\n";
}

/**
 * The bubblewrap arguments for Linux, before the program and its arguments.
 * Limit: hidden files and .talk files are protected only if they exist when the program starts,
 * and only at the top of the project. See src/md/features/sandbox-run.md.
 * "with local network" on Linux: the program gets its own loopback, so it can use servers that it starts,
 * but not servers on the host.
 */
export async function bwrapArgs(plan, cwd) {
  const args = ["--die-with-parent", "--new-session", "--unshare-all"];
  if (plan.network) {
    args.push("--share-net");
  }
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
  for (const path of plan.reads) {
    args.push("--ro-bind-try", path, path);
  }
  args.push("--bind", plan.root, plan.root);
  args.push("--bind", plan.tmp, plan.tmp);
  for (const path of plan.writes) {
    args.push("--bind-try", path, path);
  }
  // hidden files and folders at the top of the project, .talk files there, and @/talk: read only
  let entries = [];
  try {
    entries = await fs.readdir(plan.root);
  } catch (err) {
    entries = [];
  }
  for (const name of entries) {
    const isHidden = name.startsWith(".") && !plan.allowedChanges.includes(name);
    if (isHidden || name.endsWith(".talk") || name === "talk") {
      const path = nodePath.join(plan.root, name);
      if (name.startsWith(".env")) {
        args.push(...(await hideArgs(path)));
      } else {
        args.push("--ro-bind", path, path);
      }
    }
  }
  // secrets: hide them, even inside an allowed folder
  for (const path of plan.secrets) {
    args.push(...(await hideArgs(path)));
  }
  // a secret path that AGENTS.talk names: bound again after the hiding, so it wins
  for (const { path, write } of plan.opened || []) {
    args.push(write ? "--bind-try" : "--ro-bind-try", path, path);
  }
  args.push("--chdir", cwd);
  return args;
}

// bwrap arguments that hide a secret: an empty folder over a folder, /dev/null over a file
// (--tmpfs needs a folder); nothing for a path that is not there
async function hideArgs(path) {
  const stats = await fs.stat(path).catch(() => null);
  if (stats === null) {
    return [];
  }
  return stats.isDirectory() ? ["--tmpfs", path] : ["--ro-bind", "/dev/null", path];
}

/**
 * The program and arguments to spawn, with the sandbox around them.
 */
export async function wrapCommand(kind, plan, program, args, cwd) {
  if (kind === "macos") {
    return { program: "/usr/bin/sandbox-exec", args: ["-p", macosProfile(plan), program, ...args] };
  }
  if (kind === "linux") {
    return { program: "bwrap", args: [...(await bwrapArgs(plan, cwd)), "--", program, ...args] };
  }
  throw new Error("No sandbox on this OS");
}

// the self-test: node, in the sandbox, tries what the sandbox must stop
const SELF_TEST = `
const fs = require("fs");
const net = require("net");
const [outside, gitFile, port] = process.argv.slice(1);
const broken = [];
const tryIt = (name, f) => { try { f(); broken.push(name); } catch (err) {} };
// on Linux, /tmp in the sandbox is private, so the host checks the outside write after the run
try { fs.writeFileSync(outside, "x"); } catch (err) {}
tryIt("a write to .git", () => fs.writeFileSync(gitFile, "x"));
// on Linux, the home folder in the sandbox holds only the bound folders, so the host checks the names
let home = [];
try { home = fs.readdirSync(require("os").homedir()); } catch (err) {}
try { fs.writeFileSync("ok.txt", "x"); } catch (err) { broken.push("a write in the project failed"); }
const socket = net.connect(Number(port), "127.0.0.1");
socket.on("connect", () => { broken.push("a network connection"); socket.destroy(); done(); });
socket.on("error", () => done());
function done() { console.log(JSON.stringify({ broken, home })); }
`;

/**
 * Run the self-test in the sandbox. Gives the list of things that worked but must not, or the reason it failed.
 * @returns {Promise<{ ok: boolean, problems: string[] }>}
 */
export async function selfTest(kind) {
  // a temp project with a .git folder, so the test never touches a real project
  const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), "clank-sbx-project-"));
  await fs.mkdir(nodePath.join(root, ".git"));
  const tmp = await fs.mkdtemp(nodePath.join(os.tmpdir(), "clank-sbx-"));
  const outside = nodePath.join(os.tmpdir(), "clank-sbx-outside-" + process.pid);
  const server = (await import("node:net")).createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (err) {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(tmp, { recursive: true, force: true });
    return { ok: false, problems: ["the self-test could not start: " + err.message] };
  }
  try {
    const plan = await sandboxPlan({ root, tmp, programDirs: [nodePath.dirname(nodePath.dirname(process.execPath))] });
    const gitFile = nodePath.join(plan.root, ".git", "clank-talk-sandbox-probe");
    const wrapped = await wrapCommand(kind, plan, process.execPath, ["-e", SELF_TEST, outside, gitFile, String(server.address().port)], plan.root);
    const result = await new Promise((resolve) => {
      let output = "";
      const child = spawn(wrapped.program, wrapped.args, { cwd: plan.root, env: { PATH: process.env.PATH || "", TMPDIR: tmp }, shell: false });
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      child.on("error", (err) => resolve({ code: -1, output: err.message }));
      child.on("close", (code) => resolve({ code, output }));
    });
    let seen;
    try {
      seen = JSON.parse(result.output.trim().split("\n").pop());
    } catch (err) {
      let problem = "the self-test did not run: " + result.output.trim().slice(0, 300);
      // Ubuntu 23.10 and later can block the user namespaces that bwrap needs
      if (kind === "linux" && result.output.includes("bwrap:")) {
        problem += ". On Ubuntu, AppArmor can block the user namespaces that bwrap needs; see the Sandboxes part of the docs";
      }
      return { ok: false, problems: [problem] };
    }
    const problems = seen.broken;
    if (await fs.access(outside).then(() => true, () => false)) {
      problems.push("a write outside the project");
    }
    // the names in the home folder that the plan binds, such as .npm for ~/.npm/_cacache
    const bound = new Set();
    for (const path of [...plan.reads, ...plan.writes, ...plan.secrets]) {
      const relative = nodePath.relative(plan.home, path);
      if (relative !== "" && !relative.startsWith("..") && !nodePath.isAbsolute(relative)) {
        bound.add(relative.split(nodePath.sep)[0]);
      }
    }
    if (seen.home.some((name) => !bound.has(name))) {
      problems.push("a read of the home folder");
    }
    return { ok: problems.length === 0, problems };
  } finally {
    server.close();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(tmp, { recursive: true, force: true });
    await fs.rm(outside, { force: true });
  }
}
