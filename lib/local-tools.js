// Tools that work on the user's own computer — used only by the terminal app.
// They stay inside the folder where `tinker` was started, and ask before writing or running anything.

import { readFile, writeFile, readdir, mkdir, stat } from "node:fs/promises";
import { resolve, relative, dirname, sep } from "node:path";
import { exec } from "node:child_process";

const MAX_CHARS = 8000; // the free Groq tier allows only a few thousand tokens per minute
const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv"]);
const clip = (text) => (text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + "\n…(cut off)" : text);

// `ask(question)` must return true/false — the terminal shows "Allow? (y/n)".
export function localTools(ask, root = process.cwd()) {
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
        if (!(await ask(`Write ${lines} lines to ${relative(root, full)}?`))) return "The user said no. Do not write this file.";
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, content);
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
