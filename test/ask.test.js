import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/js/clank-talk.js";

async function output(source, options) {
  const result = await run(source, options);
  assert.deepEqual(result.errors, []);
  return result.output;
}

test("with no host to ask, the answer is null", async () => {
  assert.deepEqual(await output("ask 'Name?'\nprint the result"), ["null"]);
});

test("the host gets the question and the choices", async () => {
  const asked = [];
  const ask = async (request) => {
    asked.push({ question: request.question, choices: request.choices });
    return "yes";
  };
  assert.deepEqual(await output("ask 'Push ' + 2 + '?' with 'yes' or 'no'\nprint it", { ask }), ["yes"]);
  assert.deepEqual(asked, [{ question: "Push 2?", choices: ["yes", "no"] }]);
});

test("an answer that is not a choice is null", async () => {
  const ask = async () => "maybe";
  assert.deepEqual(await output("ask 'Push?' with 'yes' or 'no'\nprint it", { ask }), ["null"]);
});

test("no answer in time is null", async () => {
  const ask = () => new Promise(() => {});
  assert.deepEqual(await output("ask 'Push?' with 'yes' or 'no' within 20ms\nprint it", { ask }), ["null"]);
});

test("a host that fails to ask gives null", async () => {
  const ask = async () => {
    throw new Error("no dialog");
  };
  assert.deepEqual(await output("ask 'Name?'\nprint it", { ask }), ["null"]);
});

test("a question with no answer gives up after the time limit", async () => {
  const never = () => new Promise(() => {});
  assert.deepEqual(await output("ask 'Name?'\nprint it", { ask: never, askTimeLimit: 30 }), ["null"]);
  const result = await run("ask 'Name?'", { ask: never, askTimeLimit: 30 });
  assert.deepEqual(result.errors, []);
});
