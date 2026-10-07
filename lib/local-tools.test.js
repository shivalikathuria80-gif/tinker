// Run with: npm test
// Checks the safety rules of the local file tools.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localTools } from "./local-tools.js";

const tool = (tools, name) => tools.find((t) => t.name === name);

test("files outside the project folder are refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "tinker-"));
  const tools = localTools(async () => true, root);
  await assert.rejects(tool(tools, "read_file").run({ path: "../secret.txt" }), /inside the current folder/);
  await assert.rejects(tool(tools, "write_file").run({ path: "/etc/evil", content: "x" }), /inside the current folder/);
});

test("saying no stops writes and commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "tinker-"));
  const tools = localTools(async () => false, root);
  assert.match(await tool(tools, "write_file").run({ path: "a.txt", content: "x" }), /said no/);
  assert.equal(existsSync(join(root, "a.txt")), false);
  assert.match(await tool(tools, "run_command").run({ command: "echo hi" }), /said no/);
});

test("saying yes writes, reads and lists files", async () => {
  const root = await mkdtemp(join(tmpdir(), "tinker-"));
  const tools = localTools(async () => true, root);
  await tool(tools, "write_file").run({ path: "src/a.txt", content: "hello" });
  assert.equal(await readFile(join(root, "src/a.txt"), "utf8"), "hello");
  assert.equal(await tool(tools, "read_file").run({ path: "src/a.txt" }), "hello");
  await writeFile(join(root, "b.txt"), "");
  assert.deepEqual((await tool(tools, "list_files").run({})).split("\n").sort(), ["b.txt", "src/a.txt"]);
});

import { lineDiff, showDiff } from "./local-tools.js";

test("diff finds added, removed and unchanged lines", () => {
  const diff = lineDiff("a\nb\nc", "a\nB\nc\nd");
  assert.deepEqual(diff.map((d) => d.type + d.line), [" a", "-b", "+B", " c", "+d"]);
  const preview = showDiff("a\nb\nc", "a\nB\nc\nd", false);
  assert.match(preview, /- b/);
  assert.match(preview, /\+ B/);
  assert.match(preview, /\+2 -1/);
});

test("diff of a new file shows every line as added", () => {
  assert.deepEqual(lineDiff("", "x\ny").map((d) => d.type), ["+", "+"]);
});

import { undoLast } from "./local-tools.js";

test("/undo restores a changed file and removes a created one", async () => {
  const root = await mkdtemp(join(tmpdir(), "tinker-"));
  const undoStack = [];
  const tools = localTools(async () => true, root, undoStack);
  await writeFile(join(root, "app.js"), "old");
  await tool(tools, "write_file").run({ path: "app.js", content: "new" });
  await tool(tools, "write_file").run({ path: "created.js", content: "x" });

  assert.match(await undoLast(undoStack, async () => true), /Removed created.js/);
  assert.equal(existsSync(join(root, "created.js")), false);
  assert.match(await undoLast(undoStack, async () => true), /Restored app.js/);
  assert.equal(await readFile(join(root, "app.js"), "utf8"), "old");
  assert.match(await undoLast(undoStack, async () => true), /Nothing to undo/);
});

test("/undo asks before overwriting your own later edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "tinker-"));
  const undoStack = [];
  const tools = localTools(async () => true, root, undoStack);
  await writeFile(join(root, "a.txt"), "v1");
  await tool(tools, "write_file").run({ path: "a.txt", content: "v2" });
  await writeFile(join(root, "a.txt"), "my own edit");

  assert.match(await undoLast(undoStack, async () => false), /cancelled/);
  assert.equal(await readFile(join(root, "a.txt"), "utf8"), "my own edit");
  assert.equal(undoStack.length, 1); // still there, so you can undo later
});
