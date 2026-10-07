// Run with: npm test
// Checks that terminal chats are saved and resumed per folder.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveSession, latestSession } from "./sessions.js";

test("resume finds the latest chat for this folder only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tinker-sessions-"));
  await saveSession({ id: "a", folder: "/proj-a", messages: [{ role: "user", content: "first" }] }, dir);
  await new Promise((r) => setTimeout(r, 5));
  await saveSession({ id: "b", folder: "/proj-b", messages: [{ role: "user", content: "other project" }] }, dir);
  await new Promise((r) => setTimeout(r, 5));
  await saveSession({ id: "c", folder: "/proj-a", messages: [{ role: "user", content: "newest" }] }, dir);

  assert.equal((await latestSession("/proj-a", dir)).id, "c");
  assert.equal((await latestSession("/proj-b", dir)).id, "b");
  assert.equal(await latestSession("/nowhere", dir), null);
});

test("only the newest 30 chats are kept", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tinker-sessions-"));
  for (let i = 0; i < 33; i++) {
    await saveSession({ id: `s${i}`, folder: "/p", messages: [] }, dir);
    await new Promise((r) => setTimeout(r, 2));
  }
  const files = await readdir(dir);
  assert.equal(files.length, 30);
  assert.ok(!files.includes("s0.json"));
});
