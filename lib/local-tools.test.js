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
