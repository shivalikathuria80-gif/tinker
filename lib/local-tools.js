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
  const rel = (full) => relative(root, full).split(sep).join("/");

  // All project files under a folder (skips node_modules, .git, build folders).
  async function projectFiles(dir, limit) {
    const files = [];
    async function walk(folder) {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        if (files.length >= limit || SKIP.has(entry.name)) continue;
        const full = resolve(folder, entry.name);
        if (entry.isDirectory()) await walk(full);
        else files.push(full);
      }
    }
    await walk(dir);
    return files;
  }

  // Shows the change, asks the user, saves, and remembers the old version for /undo.
  async function saveWithApproval(full, old, content) {
    if (old === content) return "The file already has exactly this content. Nothing to change.";
    const lines = content.split("\n").length;
    const preview = old === null ? `New file, ${lines} lines:\n${showDiff("", content)}` : showDiff(old, content);
    const question = `${old === null ? "Create" : "Change"} ${rel(full)}?\n${preview}\n `;
    if (!(await ask(question))) return "The user said no. Do not make this change.";
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
    undoStack.push({ full, rel: rel(full), old, written: content });
    return `Saved ${rel(full)} (${lines} lines).`;
  }

  return [
    {
      name: "list_files",
      description: "List files in the user's project folder (or a subfolder).",
      parameters: { type: "object", properties: { path: { type: "string", description: "Folder, default '.'" } } },
      status: (a) => `Listing files in ${a.path || "."}`,
      async run({ path }) {
        const files = await projectFiles(inside(path), 400);
        return files.map(rel).join("\n") || "(empty folder)";
      },
    },
    {
      name: "search_files",
      description: "Search the project for text (case-insensitive), like 'find in files'. Returns file:line: text. Use this to find code before reading files.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, path: { type: "string", description: "Folder to search, default '.'" } },
        required: ["query"],
      },
      status: (a) => `Searching for "${a.query}"`,
      async run({ query, path }) {
        const needle = String(query).toLowerCase();
        if (!needle) return "Give a word or phrase to search for.";
        const matches = [];
        for (const full of await projectFiles(inside(path), 3000)) {
          if (matches.length >= 60) break;
          if ((await stat(full)).size > 1_000_000) continue;
          const text = await readFile(full, "utf8").catch(() => "");
          if (text.includes("\u0000")) continue; // skip binary files
          text.split("\n").forEach((line, i) => {
            if (matches.length < 60 && line.toLowerCase().includes(needle)) matches.push(`${rel(full)}:${i + 1}: ${line.trim().slice(0, 200)}`);
          });
        }
        if (!matches.length) return `No matches for "${query}".`;
        return matches.join("\n") + (matches.length >= 60 ? "\n…(more matches; search for something more specific)" : "");
      },
    },
    {
      name: "read_file",
      description: "Read a text file from the user's project folder. For big files, read only the lines you need with start_line/end_line.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, start_line: { type: "integer" }, end_line: { type: "integer" } },
        required: ["path"],
      },
      status: (a) => `Reading ${a.path}${a.start_line ? ` (lines ${a.start_line}–${a.end_line || "end"})` : ""}`,
      async run({ path, start_line, end_line }) {
        const full = inside(path);
        if ((await stat(full)).size > 1_000_000) return "File is too large to read (over 1 MB).";
        const text = await readFile(full, "utf8");
        if (!start_line && !end_line) return clip(text);
        const lines = text.split("\n");
        const from = Math.max(1, start_line || 1);
        const to = Math.min(lines.length, end_line || lines.length);
        return clip(lines.slice(from - 1, to).map((line, i) => `${from + i}: ${line}`).join("\n"));
      },
    },
    {
      name: "edit_file",
      description: "Change part of an existing file: replace old_text (copied exactly from the file, including spaces) with new_text. Prefer this over write_file for existing files.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } },
        required: ["path", "old_text", "new_text"],
      },
      status: (a) => `Wants to edit ${a.path}`,
      async run({ path, old_text, new_text }) {
        const full = inside(path);
        const old = await readFile(full, "utf8").catch(() => null);
        if (old === null) return `${path} doesn't exist. Use write_file to create it.`;
        if (!old_text) return "old_text is empty. Copy the exact lines you want to replace.";
        const count = old.split(old_text).length - 1;
        if (count === 0) return "old_text was not found in the file. Read the file again and copy the exact text (including spaces and indentation).";
        if (count > 1) return `old_text appears ${count} times. Include more surrounding lines so it matches exactly one place.`;
        return saveWithApproval(full, old, old.replace(old_text, () => new_text));
      },
    },
    {
      name: "write_file",
      description: "Create a new file, or replace a whole file, with the full content. For small changes to existing files use edit_file instead.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      status: (a) => `Wants to write ${a.path}`,
      async run({ path, content }) {
        const full = inside(path);
        const old = await readFile(full, "utf8").catch(() => null);
        return saveWithApproval(full, old, content);
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
