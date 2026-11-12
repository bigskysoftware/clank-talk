// The channel between the server part and the TUI part, for ask with real choices; see src/md/infrastructure/opencode.md
// An opencode RPC definition as a plain object: Rpc.define only checks error names and returns it (packages/schema/src/rpc.ts).
// Not named rpc.js: opencode loads a file of that name as the plugin's RPC part.

const ID = { type: "string", pattern: "^[0-9a-f]{32}$" };

export const ClankTalkChannel = {
  id: "clank-talk",
  methods: {
    // the TUI got the question and shows it; with no seen in time, the server part uses the permission prompt
    seen: {
      input: { type: "object", properties: { id: ID }, required: ["id"], additionalProperties: false },
      output: { type: "object", properties: {}, additionalProperties: false },
    },
    // the human's pick: a choice, a list of choices for "any of", typed text, or null for no answer
    answer: {
      input: {
        type: "object",
        properties: { id: ID, answer: { type: ["string", "array", "null"], items: { type: "string" } } },
        required: ["id", "answer"],
        additionalProperties: false,
      },
      output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
    },
  },
  events: {
    ask: {
      schema: {
        type: "object",
        properties: { id: ID, question: { type: "string" }, choices: { type: "array", items: { type: "string" } }, many: { type: "boolean" }, sessionID: { type: "string" } },
        required: ["id", "question", "choices", "many"],
        additionalProperties: false,
      },
    },
  },
};

// how long the server part waits for a TUI to say that it shows the question
export const SEEN_WITHIN_MS = 2000;