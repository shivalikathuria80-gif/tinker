// Run with: npm test
// Checks that long conversations are trimmed to fit Groq's free-tier limit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fitToBudget } from "./providers.js";

const total = (messages) => messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);

test("keeps the system prompt and the newest messages", () => {
  const old = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `msg ${i} ` + "x".repeat(2000) }));
  const result = fitToBudget([{ role: "system", content: "rules" }, ...old]);
  assert.equal(result[0].content, "rules");
  assert.match(result.at(-1).content, /^msg 29 /);
  assert.ok(total(result) <= 16000 + 100);
  assert.ok(result.length < 31);
});

test("shortens one huge message instead of failing", () => {
  const result = fitToBudget([{ role: "user", content: "a".repeat(400_000) }]);
  assert.equal(result.length, 1);
  assert.ok(result[0].content.length < 9000);
  assert.match(result[0].content, /shortened to fit/);
});

test("never starts with a tool result that lost its tool call", () => {
  const messages = [
    { role: "system", content: "rules" },
    { role: "user", content: "q" },
    { role: "assistant", content: "", tool_calls: [{ id: "1", function: { name: "read_file", arguments: "x".repeat(15000) } }] },
    { role: "tool", tool_call_id: "1", content: "y".repeat(7000) },
    { role: "user", content: "next" },
  ];
  const result = fitToBudget(messages);
  assert.notEqual(result[1].role, "tool");
});

import { cleanTitle } from "./providers.js";

test("chat titles are cleaned up", () => {
  assert.equal(cleanTitle('"Fixing a Python Loop Bug."'), "Fixing a Python Loop Bug");
  assert.equal(cleanTitle("Title: React Weekend Plan"), "React Weekend Plan");
  assert.equal(cleanTitle("<think>hmm</think>\n\n**Pasta Cooking Tips**"), "Pasta Cooking Tips");
  assert.equal(cleanTitle(""), "");
  assert.ok(cleanTitle("x".repeat(200)).length <= 60);
});

import { citationFilter } from "./providers.js";

test("citation codes are removed even when split across streamed pieces", () => {
  let shown = "";
  const show = citationFilter((t) => (shown += t));
  ["Groq builds chips", "【1†L1", "1-L18】", " for AI.", "【2】", " Done"].forEach(show);
  assert.equal(shown, "Groq builds chips for AI. Done");
});
