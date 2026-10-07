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

test("edit_file changes only the matching text, and refuses unclear edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "tinker-"));
  const undoStack = [];
  const tools = localTools(async () => true, root, undoStack);
  await writeFile(join(root, "a.js"), "const a = 1;\nconst b = 1;\nconst price = '$5';\n");
  const edit = tool(tools, "edit_file");

  assert.match(await edit.run({ path: "a.js", old_text: "= 1;", new_text: "= 2;" }), /appears 2 times/);
  assert.match(await edit.run({ path: "a.js", old_text: "nope", new_text: "x" }), /not found/);
  assert.match(await edit.run({ path: "a.js", old_text: "const b = 1;", new_text: "const b = 2;" }), /Saved/);
  assert.match(await edit.run({ path: "a.js", old_text: "'$5'", new_text: "'$$10'" }), /Saved/); // $ is kept as-is
  assert.equal(await readFile(join(root, "a.js"), "utf8"), "const a = 1;\nconst b = 2;\nconst price = '$$10';\n");
  assert.equal(undoStack.length, 2);
});

test("search_files finds text with file and line, read_file can read a line range", async () => {
  const root = await mkdtemp(join(tmpdir(), "tinker-"));
  const tools = localTools(async () => true, root);
  await writeFile(join(root, "cart.js"), "line one\nfunction calculateTotal() {}\nline three\n");
  assert.equal(await tool(tools, "search_files").run({ query: "CALCULATETOTAL" }), "cart.js:2: function calculateTotal() {}");
  assert.match(await tool(tools, "search_files").run({ query: "missing" }), /No matches/);
  assert.equal(await tool(tools, "read_file").run({ path: "cart.js", start_line: 2, end_line: 3 }), "2: function calculateTotal() {}\n3: line three");
});
