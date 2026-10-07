#!/usr/bin/env node
// Tinker in the terminal. Type a message, get an answer.
// Commands: /model, /skill, /connect, /clear, /help, /exit
// MCP servers: list them in ~/.tinker/mcp.json as [{ "name": "...", "url": "https://...", "token": "optional" }]
//
// By default the AI runs through the hosted Tinker server, so nobody needs an API key.
// If GROQ_API_KEY is set (in tinker/.env or ~/.tinker/.env), it calls Groq directly instead.
// Tools (your files, commands, web pages, GitHub, MCP) always run here, on your own computer.

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import * as groq from "../lib/providers.js";
import { CONNECTORS, buildTools } from "../lib/connectors.js";
import { localTools } from "../lib/local-tools.js";

const SERVER = (process.env.TINKER_SERVER || "https://tinker-ai.onrender.com").replace(/\/$/, "");
const useServer = !groq.isConfigured();
const TERMINAL_CONNECTORS = [
  { id: "files", label: "Local files + commands", description: "Read/write files and run commands in this folder (asks first)" },
  ...CONNECTORS,
];

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const accent = (s) => `\x1b[38;5;209m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

const LOGO = `
       ▲
      ▟█▙       ████████ ██ ███   ██ ██   ██ ███████ ██████
  ◀▆▆███████▆▆▶    ██    ██ ████  ██ ██  ██  ██      ██   ██
      ▜█▛          ██    ██ ██ ██ ██ █████   █████   ██████
       ▼           ██    ██ ██  ████ ██  ██  ██      ██   ██
                   ██    ██ ██   ███ ██   ██ ███████ ██   ██`;

// ---------- Talking to the AI ----------

async function getServerModels() {
  const response = await fetch(`${SERVER}/api/models`, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`server returned ${response.status}`);
  return response.json();
}

// One AI reply (used by the agent loop): through the server, or straight to Groq with your own key.
async function complete(body) {
  if (!useServer) return groq.groqComplete(body);
  const response = await fetch(`${SERVER}/api/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

// Plain streamed chat through the server (used when no tools are on).
async function streamFromServer({ modelId, messages, skill, onToken }) {
  const response = await fetch(`${SERVER}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelId, messages, skill }),
  });
  if (!response.ok) throw new Error(await response.text());
  const decoder = new TextDecoder();
  let full = "";
  for await (const chunk of response.body) {
    const text = decoder.decode(chunk, { stream: true });
    full += text;
    if (!full.includes("[[error]]")) onToken(text);
  }
  if (full.includes("[[error]]")) throw new Error(full.split("[[error]]")[1].trim());
  return full;
}

// ---------- Start ----------

console.log(accent(LOGO));
console.log(dim("\n  Free AI agents in your terminal\n"));

let MODELS;
let modelId;
try {
  if (useServer) {
    stdout.write(dim("  Connecting… (the first start can take up to a minute)\r"));
    const { models, default: fallback } = await getServerModels();
    MODELS = models;
    modelId = fallback;
    stdout.write(" ".repeat(70) + "\r");
  } else {
    MODELS = await groq.getModels();
    modelId = MODELS.some((m) => m.id === groq.DEFAULT_MODEL) ? groq.DEFAULT_MODEL : MODELS[0]?.id;
  }
} catch (error) {
  console.log(`\x1b[31mCouldn't connect to Tinker\x1b[0m (${error.message}). Check your internet and try again.`);
  process.exit(1);
}
if (!MODELS?.length) {
  console.log("\x1b[31mNo models available right now.\x1b[0m Please try again later.");
  process.exit(1);
}
if (process.argv.includes("--model")) modelId = process.argv[process.argv.indexOf("--model") + 1];

const rl = createInterface({ input: stdin, output: stdout });
const ask = async (question) => /^y/i.test(await rl.question(`${accent("  ?")} ${question} ${dim("(y/n)")} `));
const onStatus = (text) => console.log(dim(`  ● ${text}`));

let history = [];
let skill = null;
let connectors = ["files"];
let mcp = [];

// Project rules: a TINKER.md file in the current folder is added to Tinker's instructions (like CLAUDE.md).
let projectRules = "";
try {
  projectRules = readFileSync(join(process.cwd(), "TINKER.md"), "utf8").slice(0, 6000);
} catch {
  // no TINKER.md here
}

// The active skill plus the project rules, sent as one set of extra instructions.
function effectiveSkill() {
  const parts = [skill?.instructions, projectRules && `Project rules from TINKER.md:\n${projectRules}`].filter(Boolean);
  return parts.length ? { name: skill?.name || "Project rules", instructions: parts.join("\n\n") } : null;
}

try {
  mcp = JSON.parse(readFileSync(join(homedir(), ".tinker", "mcp.json"), "utf8"));
} catch {
  // no MCP servers configured
}

const folderNote =
  `\n\nYou are running in the user's terminal, in the folder ${process.cwd()}. ` +
  "Use list_files and read_file to look at their project before changing it. write_file needs the complete new file content. " +
  "Use run_command for tests, builds and git. The user approves every write and command.";

if (projectRules) console.log(dim("  Loaded project rules from TINKER.md"));
console.log(dim(`  model: ${modelId}   ·   folder: ${process.cwd()}   ·   /help for commands\n`));

while (true) {
  let input;
  try {
    input = (await rl.question(accent("› "))).trim();
  } catch {
    break; // Ctrl+C / Ctrl+D
  }
  if (!input) continue;

  if (input === "/exit" || input === "/quit") break;
  if (input === "/help") {
    console.log(dim("  /model    switch model\n  /skill    pick a skill\n  /connect  turn connectors on/off\n  /clear    start a new chat\n  /exit     quit\n"));
    continue;
  }
  if (input === "/clear") {
    history = [];
    console.log(dim("  New chat started.\n"));
    continue;
  }
  if (input === "/model") {
    MODELS.forEach((m, i) => console.log(`${m.id === modelId ? accent(" ●") : "  "} ${i + 1}. ${m.label} ${dim(`· ${m.note}`)}`));
    const pick = Number(await rl.question(dim("  Pick a number: ")));
    if (MODELS[pick - 1]) modelId = MODELS[pick - 1].id;
    console.log(dim(`  Using ${modelId}\n`));
    continue;
  }
  if (input === "/skill") {
    console.log(`${!skill ? accent(" ●") : "  "} 0. No skill`);
    groq.SKILLS.forEach((sk, i) => console.log(`${skill?.id === sk.id ? accent(" ●") : "  "} ${i + 1}. ${sk.name} ${dim(`· ${sk.description}`)}`));
    const pick = Number(await rl.question(dim("  Pick a number: ")));
    skill = groq.SKILLS[pick - 1] || null;
    console.log(dim(`  Skill: ${skill ? skill.name : "none"}\n`));
    continue;
  }
  if (input === "/connect") {
    TERMINAL_CONNECTORS.forEach((c, i) => console.log(`${connectors.includes(c.id) ? accent(" ●") : "  "} ${i + 1}. ${c.label} ${dim(`· ${c.description}`)}`));
    if (mcp.length) console.log(dim(`  MCP servers from ~/.tinker/mcp.json are always on: ${mcp.map((m) => m.name).join(", ")}`));
    const pick = TERMINAL_CONNECTORS[Number(await rl.question(dim("  Number to turn on/off: "))) - 1];
    if (pick) connectors = connectors.includes(pick.id) ? connectors.filter((c) => c !== pick.id) : [...connectors, pick.id];
    console.log(dim(`  Connectors: ${connectors.join(", ") || "none"}\n`));
    continue;
  }

  history.push({ role: "user", content: input });
  stdout.write("\n");
  try {
    const { tools, errors } = await buildTools({ connectors, mcp });
    errors.forEach(onStatus);
    if (connectors.includes("files")) tools.push(...localTools(ask));
    const builtIns = groq.builtInTools(modelId, connectors, onStatus);
    const onToken = (t) => stdout.write(t);

    let reply;
    if (tools.length || builtIns.length) {
      const system = groq.systemPrompt(effectiveSkill()) + (connectors.includes("files") ? folderNote : "");
      const conversation = [{ role: "system", content: system }, ...history];
      reply = await groq.agentLoop({ modelId, conversation, tools, builtIns, complete, onToken, onStatus, maxSteps: 15 });
    } else if (useServer) {
      reply = await streamFromServer({ modelId, messages: history, skill: effectiveSkill(), onToken });
    } else {
      reply = await groq.streamChat({ modelId, messages: history, skill: effectiveSkill(), onToken, onStatus });
    }
    history.push({ role: "assistant", content: reply });
  } catch (error) {
    history.pop();
    console.log(`\x1b[31mError:\x1b[0m ${error.message}`);
  }
  stdout.write("\n\n");
}

rl.close();
console.log(dim("Bye."));
