import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { run } from "../src/js/clank-talk.js";
import { parse } from "../src/js/parser.js";
import { readPolicy } from "../src/js/mcp.js";

let root;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "clank-policy-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const POLICY = [
  "policy 'acme-secure'",
  "require sandbox for run, start",
  "limit fetch to 'api.github.com', '*.acme.internal'",
  "limit env to PATH, HOME",
  "limit changes to @/.github/",
  "deny git push",
  "deny start",
  "audit also to '/var/log/clank-talk/'",
  "before write",
  "  reject 'This session is read only'",
  "end",
].join("\n");

test("a policy parses, and its lines are only for policies", () => {
  const { script, errors } = parse(POLICY, { definitions: true, policy: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(script.definitions.map((d) => d.type), ["policyName", "requireSandbox", "limit", "limit", "limit", "deny", "deny", "auditAlso", "hook"]);
  assert.deepEqual(script.definitions[2].values, ["api.github.com", "*.acme.internal"]);
  assert.deepEqual(script.definitions[5].what, "git push");
  assert.match(parse("deny git push", { definitions: true }).errors[0].message, /^'deny' is only allowed in a policy file/);
  assert.match(parse("tool x\nend", { definitions: true, policy: true }).errors[0].message, /^'tool' is not allowed in a policy file/);
});

test("policy hooks run first, and the audit names the policy", async () => {
  await fs.writeFile(path.join(root, "AGENTS.talk"), "before write\n  print 'AGENTS.talk hook'\nend");
  const audit = { scripts: 0, records: [] };
  const result = await run("write 'x' to ./a.txt", { root, audit, policy: { name: "acme.talk", source: RUN_POLICY } });
  assert.deepEqual(result.errors.map((e) => e.message), ["This session is read only"]);
  assert.deepEqual(result.output, []);
  const [file] = await fs.readdir(path.join(root, "talk", "audit"));
  const text = await fs.readFile(path.join(root, "talk", "audit", file), "utf8");
  const hash = createHash("sha256").update(RUN_POLICY).digest("hex").slice(0, 8);
  assert.match(text, new RegExp("\\(policy acme-secure " + hash + "\\) ==$", "m"));
});

test("an error in the policy stops the script, and names the policy file", async () => {
  const result = await run("print 1", { root, policy: { name: "acme.talk", source: "limit planets to 'mars'" } });
  assert.equal(result.status, "failed");
  assert.equal(result.errors[0].file, "acme.talk");
  assert.match(result.errors[0].message, /^Expected fetch, env or changes/);
});

test("--policy reads the file, and --policy-hash refuses a changed one", async () => {
  const file = path.join(root, "acme.talk");
  await fs.writeFile(file, POLICY);
  const hash = createHash("sha256").update(POLICY).digest("hex");
  assert.deepEqual(readPolicy([]), { policy: null });
  assert.deepEqual(readPolicy(["--policy", file, "--policy-hash", hash]), { policy: { name: "acme.talk", source: POLICY } });
  assert.match(readPolicy(["--policy", file, "--policy-hash", "0".repeat(64)]).error, /does not match --policy-hash/);
  assert.match(readPolicy(["--policy", path.join(root, "missing.talk")]).error, /^cannot read the policy/);
});

// the same policy, with no copy of the audit, for tests that run scripts
const RUN_POLICY = POLICY.replace(/^audit also.*\n/m, "");

test("AGENTS.talk allows outside the policy are load errors that name both lines", async () => {
  await fs.writeFile(path.join(root, "AGENTS.talk"), [
    "allow fetch from 'api.github.com', 'evil.com', '*.github.com'",
    "allow env PATH, SECRET",
    "allow changes to @/.github/workflows/, @/.vscode/",
    "allow git push",
  ].join("\n"));
  const result = await run("print 1", { root, policy: { name: "acme.talk", source: RUN_POLICY } });
  assert.equal(result.status, "failed");
  assert.deepEqual(result.errors.map((e) => e.file + " " + e.line + ": " + e.message), [
    "AGENTS.talk 1: 'allow fetch from 'evil.com'' is outside the policy: acme.talk 3:1 limits fetch to api.github.com, *.acme.internal",
    "AGENTS.talk 1: 'allow fetch from '*.github.com'' is outside the policy: acme.talk 3:1 limits fetch to api.github.com, *.acme.internal",
    "AGENTS.talk 2: 'allow env SECRET' is outside the policy: acme.talk 4:1 limits env to PATH, HOME",
    "AGENTS.talk 3: 'allow changes to @/.vscode/' is outside the policy: acme.talk 5:1 limits changes to @/.github/",
    "AGENTS.talk 4: 'allow git push' is not allowed: acme.talk 6:1 denies git push",
  ]);
});

test("a tool in AGENTS.talk that uses a denied thing, or runs with no sandbox, is a load error", async () => {
  await fs.writeFile(path.join(root, "AGENTS.talk"), [
    "tool ship",
    "  run 'npm test'",
    "  run 'npm pack' in a sandbox",
    "  git push",
    "end",
  ].join("\n"));
  const result = await run("print 1", { root, policy: { name: "acme.talk", source: RUN_POLICY } });
  assert.deepEqual(result.errors.map((e) => e.file + " " + e.line + ": " + e.message), [
    "AGENTS.talk 2: This run needs 'in a sandbox': acme.talk 2:1 requires it",
    "AGENTS.talk 4: This uses git push, and acme.talk 6:1 denies git push",
  ]);
});

test("at run time, the script cannot do what the policy denies, and a fetch outside the limit does not ask", async () => {
  const policy = { name: "acme.talk", source: "policy 'ro'\nlimit fetch to 'api.github.com'\ndeny writes" };
  const ask = async () => {
    throw new Error("must not ask");
  };
  const errorOf = async (script) => (await run(script, { root, ask, policy })).errors[0].message;
  assert.equal(await errorOf("write 'x' to ./a.txt"), "The policy 'ro' denies writes in this session (acme.talk 3:1)");
  assert.equal(await errorOf("fetch 'https://evil.com/'"), "fetch refused: evil.com is outside the policy 'ro' (acme.talk 2:1)");
});

test("audit also to: a copy of the audit outside the project", async () => {
  const copy = path.join(root, "outside");
  const audit = { scripts: 0, records: [] };
  const result = await run("print 1", { root: path.join(root, "project"), audit, policy: { source: "policy 'p'\naudit also to '" + copy + "'" } });
  assert.equal(result.status, "done");
  const [file] = await fs.readdir(copy);
  assert.match(await fs.readFile(path.join(copy, file), "utf8"), /\(policy p [0-9a-f]{8}\) ==/);
});
