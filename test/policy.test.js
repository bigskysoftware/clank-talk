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
  const result = await run("write 'x' to ./a.txt", { root, audit, policy: { name: "acme.talk", source: POLICY } });
  assert.deepEqual(result.errors.map((e) => e.message), ["This session is read only"]);
  assert.deepEqual(result.output, []);
  const [file] = await fs.readdir(path.join(root, "talk", "audit"));
  const text = await fs.readFile(path.join(root, "talk", "audit", file), "utf8");
  const hash = createHash("sha256").update(POLICY).digest("hex").slice(0, 8);
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
