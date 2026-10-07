// Tools that work on the user's own computer — used only by the terminal app.
// They stay inside the folder where `tinker` was started, and ask before writing or running anything.

import { readFile, writeFile, readdir, mkdir, stat, rm } from "node:fs/promises";
import { resolve, relative, dirname, sep } from "node:path";
import { exec } from "node:child_process";

const MAX_CHARS = 8000; // the free Groq tier allows only a few thousand tokens per minute
const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv"]);
const clip = (text) => (text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + "\n…(cut off)" : text);

// ---------- Showing changes before writing a file ----------

// Line-by-line diff using the "longest common subsequence" method.
// Returns [{ type: " " | "-" | "+", line }] — unchanged, removed, added.
// ponytail: O(lines²) memory; for very big files we skip the detailed view (see showDiff).
export function lineDiff(oldText, newText) {
  const a = oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");
  const common = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common[i][j] = a[i] === b[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
    }
  }
  const result = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      result.push({ type: " ", line: a[i] });
      i++;
      j++;
    } else if (i < a.length && (j === b.length || common[i + 1][j] >= common[i][j + 1])) {
      result.push({ type: "-", line: a[i] }); // removed lines are shown before added ones
      i++;
    } else {
      result.push({ type: "+", line: b[j] });
      j++;
    }
  }
  return result;
}

// Colored preview: changed lines plus 2 lines of context, at most 60 lines shown.
export function showDiff(oldText, newText, color = true) {
  const oldCount = oldText.split("\n").length;
  const newCount = newText.split("\n").length;
  if (oldCount * newCount > 4_000_000) return `  (file too large to preview: ${oldCount} → ${newCount} lines)`;
  const diff = lineDiff(oldText, newText);
  const near = (index) => diff.slice(Math.max(0, index - 2), index + 3).some((d) => d.type !== " ");
  const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const out = [];
  let skipped = false;
  diff.forEach((d, index) => {
    if (d.type === " " && !near(index)) {
      if (!skipped) out.push(paint(2, "    …"));
      skipped = true;
      return;
    }
    skipped = false;
    if (d.type === "+") out.push(paint(32, `  + ${d.line}`));
    else if (d.type === "-") out.push(paint(31, `  - ${d.line}`));
    else out.push(paint(2, `    ${d.line}`));
  });
  const added = diff.filter((d) => d.type === "+").length;
  const removed = diff.filter((d) => d.type === "-").length;
  const shown = out.length > 60 ? [...out.slice(0, 60), paint(2, `    …and ${out.length - 60} more lines`)] : out;
  return `${shown.join("\n")}\n  ${paint(32, `+${added}`)} ${paint(31, `-${removed}`)}`;
}

// `ask(question)` must return true/false — the terminal shows "Allow? (y/n)".
// ---------- Undo ----------
// Every file write is recorded in `undoStack` as { full, rel, old, written }.
// old = the file before Tinker changed it (null if Tinker created it), written = what Tinker saved.

export async function undoLast(undoStack, ask) {
  const entry = undoStack.pop();
  if (!entry) return "Nothing to undo. (Only file changes Tinker made in this chat can be undone.)";
  const current = await readFile(entry.full, "utf8").catch(() => null);
  if (current !== entry.written && !(await ask(`${entry.rel} was changed after Tinker wrote it. Undo anyway and lose those edits?`))) {
    undoStack.push(entry);
    return "Undo cancelled.";
  }
  if (entry.old === null) {
    await rm(entry.full, { force: true });
    return `Removed ${entry.rel} (Tinker had created it).`;
  }
  await writeFile(entry.full, entry.old);
  return `Restored ${entry.rel} to how it was before Tinker's change.`;
}

export function localTools(ask, root = process.cwd(), undoStack = []) {
  const inside = (path) => {
    const full = resolve(root, path || ".");
    if (full !== root && !full.startsWith(root + sep)) throw new Error("Only files inside the current folder are allowed.");
    return full;
  };

  return [
    {
      name: "list_files",
      description: "List files in the user's project folder (or a subfolder).",
      parameters: { type: "object", properties: { path: { type: "string", description: "Folder, default '.'" } } },
      status: (a) => `Listing files in ${a.path || "."}`,
      async run({ path }) {
        const files = [];
        async function walk(dir) {
          for (const entry of await readdir(dir, { withFileTypes: true })) {
            if (files.length >= 400 || SKIP.has(entry.name)) continue;
            const full = resolve(dir, entry.name);
            if (entry.isDirectory()) await walk(full);
            else files.push(relative(root, full).split(sep).join("/"));
          }
        }
        await walk(inside(path));
        return files.join("\n") || "(empty folder)";
      },
    },
    {
      name: "read_file",
      description: "Read a text file from the user's project folder.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      status: (a) => `Reading ${a.path}`,
      async run({ path }) {
        const full = inside(path);
        if ((await stat(full)).size > 1_000_000) return "File is too large to read (over 1 MB).";
        return clip(await readFile(full, "utf8"));
      },
    },
    {
      name: "write_file",
      description: "Create or overwrite a file in the user's project folder with the full new content.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      status: (a) => `Wants to write ${a.path}`,
      async run({ path, content }) {
        const full = inside(path);
        const lines = content.split("\n").length;
        const old = await readFile(full, "utf8").catch(() => null);
        const preview = old === null ? `New file, ${lines} lines:\n${showDiff("", content)}` : showDiff(old, content);
        if (old === content) return "The file already has exactly this content. Nothing to change.";
        const question = `${old === null ? "Create" : "Change"} ${relative(root, full)}?\n${preview}\n `;
        if (!(await ask(question))) return "The user said no. Do not write this file.";
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, content);
        undoStack.push({ full, rel: relative(root, full), old, written: content });
        return `Saved ${relative(root, full)} (${lines} lines).`;
      },
    },
    {
      name: "run_command",
      description: "Run a shell command in the user's project folder (e.g. tests, builds, git status). Returns the output.",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      status: (a) => `Wants to run: ${a.command}`,
      async run({ command }) {
        if (!(await ask(`Run this command?\n    ${command}\n `))) return "The user said no. Do not run this command.";
        return new Promise((done) => {
          exec(command, { cwd: root, timeout: 120_000, maxBuffer: 5_000_000 }, (error, stdout, stderr) => {
            const code = error ? `exit code ${error.code ?? "?"}${error.killed ? " (timed out after 2 minutes)" : ""}` : "exit code 0";
            done(clip(`${code}\n${stdout}${stderr ? `\nSTDERR:\n${stderr}` : ""}`));
          });
        });
      },
    },
  ];
}
