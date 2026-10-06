#!/usr/bin/env node
// Tinker in the terminal. Type a message, get a streamed answer.
// Commands: /model, /clear, /help, /exit

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getModels, DEFAULT_MODEL, USER_ENV_PATH, isConfigured, streamChat } from "../lib/providers.js";

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const accent = (s) => `\x1b[38;5;209m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

const rl = createInterface({ input: stdin, output: stdout });

// First run (or `tinker setup`): ask for a Groq key and save it in ~/.tinker/.env
if (!isConfigured() || process.argv[2] === "setup") {
  console.log(`\n${accent("◆")} ${bold("Tinker setup")} ${dim("— get a free key at https://console.groq.com/keys")}\n`);
  const apiKey = (await rl.question("Groq API key: ")).trim();
  if (!apiKey) {
    console.log("No key entered. Run `tinker setup` when you have one.");
    process.exit(1);
  }
  mkdirSync(dirname(USER_ENV_PATH), { recursive: true });
  writeFileSync(USER_ENV_PATH, `GROQ_API_KEY=${apiKey}\n`, { mode: 0o600 });
  process.env.GROQ_API_KEY = apiKey;
  console.log(dim(`  Saved to ${USER_ENV_PATH}\n`));
}

const MODELS = await getModels();
if (MODELS.length === 0) {
  console.log(`\x1b[31mCouldn't load models from Groq.\x1b[0m Check your internet and your key with \`tinker setup\`.`);
  process.exit(1);
}

let modelId = process.argv.includes("--model")
  ? process.argv[process.argv.indexOf("--model") + 1]
  : MODELS.some((m) => m.id === DEFAULT_MODEL) ? DEFAULT_MODEL : MODELS[0].id;
let history = [];

function printModels() {
  MODELS.forEach((m, i) => {
    const status = isConfigured(m.provider) ? "" : dim("  (no key)");
    const current = m.id === modelId ? accent(" ●") : "  ";
    console.log(`${current} ${i + 1}. ${m.label} ${dim(`· ${m.provider} · ${m.note}`)}${status}`);
  });
}

console.log(`\n${accent("◆")} ${bold("Tinker")} ${dim("— free AI agents in your terminal")}`);
console.log(dim(`  model: ${modelId}   ·   /model to switch · /clear · /exit\n`));

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
    console.log(dim("  /model  switch model\n  /clear  start a new chat\n  /exit   quit\n"));
    continue;
  }
  if (input === "/clear") {
    history = [];
    console.log(dim("  New chat started.\n"));
    continue;
  }
  if (input === "/model") {
    printModels();
    const pick = Number(await rl.question(dim("  Pick a number: ")));
    if (MODELS[pick - 1]) modelId = MODELS[pick - 1].id;
    console.log(dim(`  Using ${modelId}\n`));
    continue;
  }

  history.push({ role: "user", content: input });
  stdout.write("\n");
  try {
    const reply = await streamChat({ modelId, messages: history, onToken: (t) => stdout.write(t) });
    history.push({ role: "assistant", content: reply });
  } catch (error) {
    history.pop();
    console.log(`\x1b[31mError:\x1b[0m ${error.message}`);
  }
  stdout.write("\n\n");
}

rl.close();
console.log(dim("Bye."));
