// Run with: npm test
// Checks that terminal chats are converted to the format Firestore's web API expects.

import { test } from "node:test";
import assert from "node:assert/strict";
import { toFirestore } from "./cloud.js";

test("chats are converted to Firestore's typed values", () => {
  const chat = { id: "cli-1", title: "Fix bug", updated: 1700000000000, ratio: 0.5, source: "terminal", done: true, messages: [{ role: "user", content: "hi" }] };
  assert.deepEqual(toFirestore(chat), {
    mapValue: {
      fields: {
        id: { stringValue: "cli-1" },
        title: { stringValue: "Fix bug" },
        updated: { integerValue: "1700000000000" },
        ratio: { doubleValue: 0.5 },
        source: { stringValue: "terminal" },
        done: { booleanValue: true },
        messages: { arrayValue: { values: [{ mapValue: { fields: { role: { stringValue: "user" }, content: { stringValue: "hi" } } } }] } },
      },
    },
  });
  assert.deepEqual(toFirestore(null), { nullValue: null });
});
