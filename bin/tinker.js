#!/usr/bin/env node
// Tinker in the terminal. Type a message, get a streamed answer.
// Commands: /model, /skill, /connect, /clear, /help, /exit
// MCP servers: list them in ~/.tinker/mcp.json as [{ "name": "...", "url": "https://...", "token": "optional" }]
//
// By default it talks to the hosted Tinker server, so nobody needs an API key.
// If GROQ_API_KEY is set (in tinker/.env or ~/.tinker/.env), it calls Groq directly instead.

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import * as groq from "../lib/providers.js";
import { CONNECTORS } from "../lib/connectors.js";

const SERVER = (process.env.TINKER_SERVER || "https://tinker-ai.onrender.com").replace(/\/$/, "");
const useServer = !groq.isConfigured();

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

// ---------- Talking to the hosted server ----------

async function getServerModels() {
  const response = await fetch(`${SERVER}/api/models`, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`server returned ${response.status}`);
  return response.json();
}

async function streamFromServer({ modelId, messages, onToken, onStatus, skill, connectors, mcp }) {
  const response = await fetch(`${SERVER}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelId, messages, skill: skill && { id: skill.id }, connectors, mcp }),
  });
  if (!response.ok) throw new Error(await response.text());
  const decoder = new TextDecoder();
  let full = "";
  for await (const chunk of response.body) {
    let text = decoder.decode(chunk, { stream: true });
    // Lines like "[[tool]] Reading example.com" are connector status updates
    text = text.replace(/^\[\[tool\]\] (.*)\n?/gm, (_, status) => {
      onStatus(status);
      return "";
    });
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

const streamChat = useServer ? streamFromServer : groq.streamChat;
const rl = createInterface({ input: stdin, output: stdout });
let history = [];
let skill = null;
let connectors = [];
let mcp = [];
try {
  mcp = JSON.parse(readFileSync(join(homedir(), ".tinker", "mcp.json"), "utf8"));
} catch {
  // no MCP servers configured
}
const SKILLS = useServer ? (await getServerModels()).skills : groq.SKILLS;
const onStatus = (text) => console.log(dim(`  ● ${text}`));

console.log(dim(`  model: ${modelId}   ·   /help for commands\n`));

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
    SKILLS.forEach((sk, i) => console.log(`${skill?.id === sk.id ? accent(" ●") : "  "} ${i + 1}. ${sk.name} ${dim(`· ${sk.description}`)}`));
    const pick = Number(await rl.question(dim("  Pick a number: ")));
    skill = SKILLS[pick - 1] || null;
    console.log(dim(`  Skill: ${skill ? skill.name : "none"}\n`));
    continue;
  }
  if (input === "/connect") {
    CONNECTORS.forEach((c, i) => console.log(`${connectors.includes(c.id) ? accent(" ●") : "  "} ${i + 1}. ${c.label} ${dim(`· ${c.description}`)}`));
    if (mcp.length) console.log(dim(`  MCP servers from ~/.tinker/mcp.json are always on: ${mcp.map((m) => m.name).join(", ")}`));
    const pick = CONNECTORS[Number(await rl.question(dim("  Number to turn on/off: "))) - 1];
    if (pick) connectors = connectors.includes(pick.id) ? connectors.filter((c) => c !== pick.id) : [...connectors, pick.id];
    console.log(dim(`  Connectors: ${connectors.join(", ") || "none"}\n`));
    continue;
  }

  history.push({ role: "user", content: input });
  stdout.write("\n");
  try {
    const reply = await streamChat({ modelId, messages: history, onToken: (t) => stdout.write(t), onStatus, skill, connectors, mcp });
    history.push({ role: "assistant", content: reply });
  } catch (error) {
    history.pop();
    console.log(`\x1b[31mError:\x1b[0m ${error.message}`);
  }
  stdout.write("\n\n");
}

rl.close();
console.log(dim("Bye."));
