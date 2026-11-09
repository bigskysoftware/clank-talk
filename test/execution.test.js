import { test } from "node:test";
import assert from "node:assert/strict";
import { start, run } from "../src/js/clank-talk.js";

test("start gives an execution object at once", async () => {
  const execution = start("print 1");
  assert.equal(execution.status, "running");
  const result = await execution.done;
  assert.equal(execution.status, "done");
  assert.deepEqual(result, { status: "done", output: ["1"], errors: [], steps: 1 });
});

test("run is a short form of start(...).done", async () => {
  assert.deepEqual(await run("print 1"), { status: "done", output: ["1"], errors: [], steps: 1 });
});

test("a parse error gives status failed", async () => {
  const result = await run("print");
  assert.equal(result.status, "failed");
});

test("a runtime error gives status failed", async () => {
  const execution = start("print 1 / 0");
  await execution.done;
  assert.equal(execution.status, "failed");
  assert.equal(execution.errors[0].message, "Division by zero");
});

test("onStep sees each step", async () => {
  const seen = [];
  await run("print 1\nif true\n  print 2\nend", {
    onStep: (step) => seen.push(step.type + "@" + step.line + " #" + step.steps),
  });
  assert.deepEqual(seen, ["print@1 #1", "if@2 #2", "print@3 #3"]);
});

test("the host can watch output while the script runs", async () => {
  const seen = [];
  const execution = start("print 'a' print 'b' print 'c'", {
    onStep: () => seen.push(execution.output.length),
  });
  await execution.done;
  assert.deepEqual(seen, [0, 1, 2]);
});

test("cancel stops the script at the next step", async () => {
  const execution = start("repeat while true\n  print 'x'\nend", {
    onStep: (step) => {
      if (step.steps === 5) {
        execution.cancel();
      }
    },
  });
  const result = await execution.done;
  assert.equal(result.status, "cancelled");
  assert.equal(result.errors[0].message, "Cancelled");
  assert.equal(result.steps, 5);
});

test("a host signal cancels the script", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await run("print 1", { signal: controller.signal });
  assert.equal(result.status, "cancelled");
  assert.deepEqual(result.output, []);
});

test("cancel reaches a slow tool through its signal", async () => {
  const tools = {
    slow: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")));
    }),
  };
  const execution = start("slow print 'never'", { tools });
  setTimeout(() => execution.cancel(), 10);
  const result = await execution.done;
  assert.equal(result.status, "cancelled");
  assert.deepEqual(result.output, []);
});

test("a tool that fails gives a script error", async () => {
  const tools = { broken: async () => { throw new Error("boom"); } };
  const result = await run("broken", { tools });
  assert.equal(result.status, "failed");
  assert.equal(result.errors[0].message, "Tool 'broken' failed: boom");
});
