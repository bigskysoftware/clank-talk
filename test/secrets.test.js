import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { run } from "../src/js/clank-talk.js";

// see src/md/features/secrets.md
const TOKEN = "tok-1234567890";

let root;
let server;
let base;
let otherServer;
let otherBase;
let seen;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "clank-secrets-"));
  server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      seen = { auth: request.headers.authorization || null, body };
      if (request.url === "/echo") {
        // the server sends the token back, so the response must show <secret ...>
        response.end("got " + (request.headers.authorization || "") + " " + body);
      } else if (request.url === "/to-other") {
        response.writeHead(302, { Location: otherBase + "/" });
        response.end();
      } else if (request.url === "/put-to-other") {
        response.writeHead(301, { Location: otherBase + "/" });
        response.end();
      } else {
        response.end("ok");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = "http://127.0.0.1:" + server.address().port;
  otherServer = http.createServer((request, response) => {
    seen = { auth: request.headers.authorization || null, other: true };
    response.end("other");
  });
  await new Promise((resolve) => otherServer.listen(0, "127.0.0.1", resolve));
  otherBase = "http://127.0.0.1:" + otherServer.address().port;
  await fs.writeFile(path.join(root, ".env"), "TOKEN=" + TOKEN + "\nRUN_TOKEN=run-abcdefgh12\nRUN_OTHER=other-abcdefgh\n");
  await fs.writeFile(path.join(root, "AGENTS.talk"), [
    "allow env PATH",
    "allow fetch from '127.0.0.1', 'localhost'",
    "allow secret TOKEN for fetch to '127.0.0.1'",
    "allow secret RUN_TOKEN for run",
    "allow secret RUN_OTHER for run",
    "",
    "tool echo_it with text",
    "  run 'echo' with text",
    "end",
    "",
    "tool show_env_file",
    "  run 'cat' with '.env'",
    "end",
    "",
    "tool show_run_token",
    "  run 'printenv' with 'RUN_TOKEN' using secret RUN_TOKEN",
    "end",
    "",
    "tool show_both",
    "  run 'env' using secrets RUN_TOKEN, RUN_OTHER",
    "end",
    "",
    "tool show_no_token",
    "  run 'printenv' with 'RUN_TOKEN'",
    "end",
    "",
    "tool start_run_token",
    "  start 'printenv' with 'RUN_TOKEN' as 'env-printer' using secret RUN_TOKEN",
    "end",
  ].join("\n"));
});

after(async () => {
  server.close();
  otherServer.close();
  await fs.rm(root, { recursive: true, force: true });
});

async function output(source, options = {}) {
  const result = await run(source, { root, ...options });
  assert.deepEqual(result.errors, []);
  return result.output;
}

async function errors(source, options = {}) {
  const result = await run(source, { root, ...options });
  return result.errors.map((e) => e.message);
}

test("print shows a secret as <secret NAME>, also when joined", async () => {
  assert.deepEqual(await output("print secret TOKEN"), ["<secret TOKEN>"]);
  assert.deepEqual(await output("print 'Bearer ' + secret TOKEN"), ["Bearer <secret TOKEN>"]);
  assert.deepEqual(await output("print 'Bearer ${secret TOKEN}!'"), ["Bearer <secret TOKEN>!"]);
  assert.deepEqual(await output("set t to secret TOKEN\nprint [t, 1]"), ['["<secret TOKEN>",1]']);
  assert.deepEqual(await output("print { auth: 'Bearer ' + secret TOKEN }"), ['{"auth":"Bearer <secret TOKEN>"}']);
});

test("secret alone is still a plain word", async () => {
  assert.deepEqual(await output("set secret to 1\nprint secret + 1"), ["2"]);
});

test("a secret cannot go anywhere else", async () => {
  const hint = ". Use it in fetch headers or body to 127.0.0.1.";
  assert.deepEqual(await errors("write secret TOKEN to ./out.txt"), ["A secret cannot go into write: TOKEN" + hint]);
  assert.deepEqual(await errors("append 'x' + secret TOKEN to ./out.txt"), ["A secret cannot go into append: TOKEN" + hint]);
  assert.deepEqual(await errors("if secret TOKEN is 'x'\n  print 1\nend"), ["A secret cannot go into 'is': TOKEN" + hint]);
  assert.deepEqual(await errors("print secret TOKEN contains 'tok'"), ["A secret cannot go into 'contains': TOKEN" + hint]);
  assert.deepEqual(await errors("print secret TOKEN starts with 't'"), ["A secret cannot go into 'starts with': TOKEN" + hint]);
  assert.deepEqual(await errors("print secret TOKEN's length"), ["A secret cannot go into 'length': TOKEN" + hint]);
  assert.deepEqual(await errors("print secret TOKEN as text"), ["A secret cannot go into 'as text': TOKEN" + hint]);
  assert.deepEqual(await errors("print secret TOKEN exists"), ["A secret cannot go into 'exists': TOKEN" + hint]);
  assert.deepEqual(await errors("print secret TOKEN is empty"), ["A secret cannot go into 'is empty': TOKEN" + hint]);
  assert.deepEqual(await errors("print [secret TOKEN] as json"), ["A secret cannot be used here: TOKEN" + hint]);
  assert.deepEqual(await errors("echo_it secret TOKEN"), ["A secret cannot go into run: TOKEN" + hint]);
  assert.deepEqual(await errors("ask 'Use ' + secret TOKEN + '?'"), ["A secret cannot go into ask: TOKEN" + hint]);
  assert.deepEqual(await errors(`set u to '${base}/?k=' + secret TOKEN\nfetch u`), ["A secret cannot go into the fetch URL: TOKEN" + hint]);
  await assert.rejects(fs.access(path.join(root, "out.txt")));
});

test("on error can catch a secret error", async () => {
  assert.deepEqual(await output("on error\n  print error's message\n  continue\nend\nwrite secret TOKEN to ./out.txt"), ["A secret cannot go into write: TOKEN. Use it in fetch headers or body to 127.0.0.1."]);
});

test("a secret needs an allow line and a value", async () => {
  assert.deepEqual(await errors("print secret OTHER"), ["AGENTS.talk does not allow secret OTHER.\nTo allow it, a human can add this line to AGENTS.talk:\n  allow secret OTHER for fetch to '<host>'"]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clank-secrets-"));
  try {
    await fs.writeFile(path.join(dir, "AGENTS.talk"), "allow secret MISSING_ONE for fetch to 'api.github.com'");
    // a missing value is an error only where a script uses it
    assert.deepEqual((await run("print 1", { root: dir })).output, ["1"]);
    assert.deepEqual((await run("print secret MISSING_ONE", { root: dir })).errors.map((e) => e.message), ["No value for secret MISSING_ONE. Put it in the environment, in .env.local or in .env."]);
    await fs.writeFile(path.join(dir, ".env"), "MISSING_ONE=short\n");
    const result = await run("print 1", { root: dir });
    assert.equal(result.errors[0].message, "The value of secret MISSING_ONE is shorter than 8 characters, so it cannot be kept out of the output. Use a longer value, or remove the allow line.");
    assert.equal(result.errors[0].file, "AGENTS.talk");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("allow secret is only for AGENTS.talk, and needs for fetch to or for run", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clank-secrets-"));
  try {
    await fs.writeFile(path.join(dir, "AGENTS.talk"), "import ./more.talk");
    await fs.writeFile(path.join(dir, "more.talk"), "allow secret X for fetch to 'a.com'");
    assert.deepEqual((await run("print 1", { root: dir })).errors.map((e) => e.message), ["'allow secret' is only allowed in AGENTS.talk"]);
    await fs.writeFile(path.join(dir, "AGENTS.talk"), "allow secret X for push");
    assert.deepEqual((await run("print 1", { root: dir })).errors.map((e) => e.message), ["Expected 'fetch', 'run' or 'subagents', as in: allow secret X for fetch to 'api.github.com'"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the environment wins, then .env.local, then .env", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clank-secrets-"));
  try {
    await fs.writeFile(path.join(dir, "AGENTS.talk"), "allow secret CLANK_TEST_ORDER for fetch to '127.0.0.1'\nallow fetch from '127.0.0.1'");
    await fs.writeFile(path.join(dir, ".env"), "# a comment\nexport CLANK_TEST_ORDER='from-dot-env' # not this\n");
    const sent = async () => {
      const result = await run(`fetch '${base}/' with headers: { Authorization: secret CLANK_TEST_ORDER }`, { root: dir });
      assert.deepEqual(result.errors, []);
      return seen.auth;
    };
    assert.equal(await sent(), "from-dot-env");
    await fs.writeFile(path.join(dir, ".env.local"), 'CLANK_TEST_ORDER="from-local"\n');
    assert.equal(await sent(), "from-local");
    process.env.CLANK_TEST_ORDER = "from-environment";
    assert.equal(await sent(), "from-environment");
  } finally {
    delete process.env.CLANK_TEST_ORDER;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("fetch sends the real value in headers and the body, to the allowed host", async () => {
  await output(`fetch '${base}/' with headers: { Authorization: 'Bearer ' + secret TOKEN }`);
  assert.equal(seen.auth, "Bearer " + TOKEN);
  await output(`fetch '${base}/' with method: 'POST', body: { token: secret TOKEN, n: 1 }`);
  assert.equal(seen.body, JSON.stringify({ token: TOKEN, n: 1 }));
  await output("fetch '" + base + "/' with method: 'POST', body: 'key=${secret TOKEN}'");
  assert.equal(seen.body, "key=" + TOKEN);
});

test("a secret cannot go to another host", async () => {
  seen = null;
  assert.deepEqual(await errors(`fetch 'http://localhost:${otherServer.address().port}/' with headers: { Authorization: secret TOKEN }`), ["A secret cannot go to localhost: TOKEN. It can go only to 127.0.0.1."]);
  assert.equal(seen, null);
});

test("a redirect to another host drops the secret, and the audit records the redirect", async () => {
  const audit = { scripts: 0, records: [] };
  await output(`fetch '${base}/to-other' with headers: { Authorization: secret TOKEN }`, { audit });
  assert.deepEqual(seen, { auth: null, other: true });
  const redirect = audit.records.find((record) => record.kind === "redirect");
  assert.equal(redirect.target, base + "/to-other");
  assert.equal(redirect.details, "302 to " + otherBase + "/");
  const fetched = audit.records.find((record) => record.kind === "fetch");
  assert.match(fetched.details, /  \(secret TOKEN\)  \(untrusted from http:\/\/127\.0\.0\.1:\d+\/\)$/);
  // a 301 after a PUT keeps the body, so it does not go on to another host
  assert.deepEqual(await errors(`fetch '${base}/put-to-other' with method: 'PUT', body: secret TOKEN`), [`fetch will not send the body on to another host: ${base} redirects to ${otherBase}`]);
});

test("a hook sees the names of the secrets in a fetch", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clank-secrets-"));
  try {
    await fs.writeFile(path.join(dir, ".env"), "TOKEN=" + TOKEN + "\n");
    await fs.writeFile(path.join(dir, "AGENTS.talk"), "allow fetch from '127.0.0.1'\nallow secret TOKEN for fetch to '127.0.0.1'\n\nbefore fetch\n  if the fetch's secrets is not empty\n    reject 'no secrets today: ' + the fetch's secrets\n  end\nend");
    const result = await run(`fetch '${base}/' with headers: { Authorization: secret TOKEN }`, { root: dir });
    assert.deepEqual(result.errors.map((e) => e.message), ['no secrets today: ["TOKEN"]']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a secret's value shows as <secret NAME> in fetch responses, run output, print and errors", async () => {
  assert.deepEqual(await output(`fetch '${base}/echo' with headers: { Authorization: secret TOKEN }\nprint it`), ["got <secret TOKEN> "]);
  assert.deepEqual(await output("show_env_file\nprint it's output"), ["TOKEN=<secret TOKEN>\nRUN_TOKEN=<secret RUN_TOKEN>\nRUN_OTHER=<secret RUN_OTHER>\n"]);
  // a file read is not changed, so an edit cannot lose the token; print still hides it
  await fs.writeFile(path.join(root, "config.txt"), "key: " + TOKEN + "\n");
  assert.deepEqual(await output("print read ./config.txt"), ["key: <secret TOKEN>\n"]);
  assert.deepEqual(await output("replace 'key' with 'token' in ./config.txt"), []);
  assert.equal(await fs.readFile(path.join(root, "config.txt"), "utf8"), "token: " + TOKEN + "\n");
  assert.deepEqual(await errors("print (read ./config.txt) as number"), ["Expected a number, found 'token: <secret TOKEN>\n'"]);
});

// ----- allow secret NAME for run, and run ... using secret NAME -----

test("a run that is provided a secret gets it in its environment, and others do not", async () => {
  assert.deepEqual(await output("show_run_token\nprint it's output"), ["<secret RUN_TOKEN>\n"]);
  const [both] = await output("show_both\nprint it's output");
  assert.match(both, /^RUN_TOKEN=<secret RUN_TOKEN>$/m);
  assert.match(both, /^RUN_OTHER=<secret RUN_OTHER>$/m);
  assert.deepEqual(await output("show_no_token\nprint it's code"), ["1"]);
});

test("a start that is provided a secret gets it too", async () => {
  const processes = new Map();
  try {
    assert.deepEqual(await output("start_run_token\nwait until (process 'env-printer')'s status is 'exited' within 5 seconds\nprint (process 'env-printer')'s output", { processes }), ["<secret RUN_TOKEN>\n"]);
  } finally {
    for (const record of processes.values()) {
      record.child.kill();
    }
  }
});

test("the audit and hooks see the names of the secrets that a run is provided", async () => {
  const audit = { scripts: 0, records: [] };
  await output("show_run_token", { audit });
  const ran = audit.records.find((record) => record.kind === "run");
  assert.match(ran.details, /  \(secret RUN_TOKEN\)$/);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clank-secrets-"));
  try {
    await fs.writeFile(path.join(dir, ".env"), "RUN_TOKEN=run-abcdefgh12\n");
    await fs.writeFile(path.join(dir, "AGENTS.talk"), "allow env PATH\nallow secret RUN_TOKEN for run\n\nbefore run\n  if the run's secrets is not empty\n    reject 'no: ' + the run's secrets\n  end\nend\n\ntool t\n  run 'printenv' using secret RUN_TOKEN\nend");
    assert.deepEqual((await run("t", { root: dir })).errors.map((e) => e.message), ['no: ["RUN_TOKEN"]']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a run-only secret cannot go anywhere else", async () => {
  assert.deepEqual(await errors("write secret RUN_TOKEN to ./out.txt"), ["A secret cannot go into write: RUN_TOKEN. Use it in a tool, with: run ... using secret RUN_TOKEN."]);
  assert.deepEqual(await errors(`fetch '${base}/' with headers: { Authorization: secret RUN_TOKEN }`), ["A secret cannot go to 127.0.0.1: RUN_TOKEN. It can go only to a run or start in a tool that is provided it."]);
});

test("load errors for secrets in a run", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clank-secrets-"));
  const loadErrors = async (agents) => {
    await fs.writeFile(path.join(dir, "AGENTS.talk"), agents);
    return (await run("print 1", { root: dir })).errors.map((e) => e.message);
  };
  try {
    assert.deepEqual(await loadErrors("allow env PATH, NPM_TOKEN\nallow secret NPM_TOKEN for run"), ["NPM_TOKEN is in both 'allow env' and 'allow secret'. Remove it from 'allow env', so only the runs that are provided it get it."]);
    assert.deepEqual(await loadErrors("tool publish\n  run 'npm publish' using secret NPM_TOKEN\nend"), ["The tool publish is provided secret NPM_TOKEN, but AGENTS.talk has no 'allow secret NPM_TOKEN for run'."]);
    assert.deepEqual(await loadErrors("allow secret NPM_TOKEN for fetch to 'registry.npmjs.org'\n\ntool publish\n  run 'npm publish' using secret NPM_TOKEN\nend"), ["The tool publish is provided secret NPM_TOKEN, but AGENTS.talk has no 'allow secret NPM_TOKEN for run'."]);
    assert.deepEqual(await loadErrors("tool publish\n  run 'npm publish' using NPM_TOKEN\nend"), ["Expected 'secret' or 'secrets', as in: using secret NPM_TOKEN"]);
    // a missing value is an error only when the run happens
    assert.deepEqual(await loadErrors("allow secret NPM_TOKEN_NOT_SET for run\n\ntool publish\n  run 'npm publish' using secret NPM_TOKEN_NOT_SET\nend"), []);
    assert.deepEqual((await run("publish", { root: dir })).errors.map((e) => e.message), ["No value for secret NPM_TOKEN_NOT_SET. Put it in the environment, in .env.local or in .env."]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the changed files that the host shows hide a secret's value, but the file and undo keep it", async () => {
  await fs.writeFile(path.join(root, "copy-me.txt"), "key: " + TOKEN + "\n");
  const result = await run("write read ./copy-me.txt to ./copied.txt", { root });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.changes.map((change) => change.after), ["key: <secret TOKEN>\n"]);
  assert.equal(await fs.readFile(path.join(root, "copied.txt"), "utf8"), "key: " + TOKEN + "\n");
  await fs.writeFile(path.join(root, "copy-me.txt"), "changed\n");
  const undo = [];
  const edit = await run("replace 'key' with 'token' in ./copied.txt", { root, undo });
  assert.deepEqual(edit.changes.map((change) => change.before), ["key: <secret TOKEN>\n"]);
  assert.deepEqual((await run("undo", { root, undo })).errors, []);
  assert.equal(await fs.readFile(path.join(root, "copied.txt"), "utf8"), "key: " + TOKEN + "\n");
});
