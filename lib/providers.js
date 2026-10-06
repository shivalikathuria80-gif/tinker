// Shared by the web server and the terminal app.
// Everything goes through OmniRoute, which speaks the OpenAI-compatible format.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// Settings saved by `tinker` on first run (used when installed from npm).
export const USER_ENV_PATH = join(homedir(), ".tinker", ".env");

// Load .env files into process.env. The project folder wins over the home folder.
for (const envPath of [join(dirname(fileURLToPath(import.meta.url)), "..", ".env"), USER_ENV_PATH]) {
  if (existsSync(envPath)) process.loadEnvFile(envPath);
}

export const DEFAULT_MODEL = "Tinker AI Model Bundle";

export const SYSTEM_PROMPT =
  "You are Tinker, a sharp, friendly AI agent. You help people write and debug code, " +
  "solve problems step by step, and automate tasks. Be concise. Use Markdown and fenced " +
  "code blocks with a language tag. When unsure, say so.";

function providerConfig() {
  return {
    baseUrl: (process.env.OMNIROUTE_BASE_URL || "http://localhost:20128/v1").replace(/\/$/, ""),
    apiKey: process.env.OMNIROUTE_API_KEY,
  };
}

export function isConfigured() {
  return Boolean(providerConfig().apiKey);
}

// Only combos are offered: your own combos first, then OmniRoute's built-in auto/* ones.
// Single provider models are left out on purpose.
let cache = [];

export async function getModels() {
  if (cache.length) return cache;
  const { baseUrl, apiKey } = providerConfig();
  if (!apiKey) return [];
  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return [];
    const { data = [] } = await response.json();
    const seen = new Set();
    const combos = data.filter((m) => {
      // Skip combos whose name only differs in capital letters (e.g. "Bundle" vs "bundle").
      const key = m.id.toLowerCase();
      if (m.owned_by !== "combo" || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const mine = combos.filter((m) => !m.id.startsWith("auto/"));
    const builtIn = combos.filter((m) => m.id.startsWith("auto/"));
    cache = [
      ...mine.map((m) => ({ id: m.id, label: m.id, provider: "omniroute", note: "Your combo" })),
      ...builtIn.map((m) => ({ id: m.id, label: m.id, provider: "omniroute", note: "Built-in combo" })),
    ];
    return cache;
  } catch {
    return []; // OmniRoute not running
  }
}

// Sends the conversation to the AI and calls onToken for each piece of text
// as it streams in. Resolves with the full reply.
export async function streamChat({ modelId, messages, onToken, signal }) {
  const model = (await getModels()).find((m) => m.id === modelId);
  if (!model) throw new Error(`Unknown model "${modelId}".`);

  const { baseUrl, apiKey } = providerConfig();
  if (!apiKey) throw new Error("OMNIROUTE_API_KEY is not set. Add it to tinker/.env and restart.");

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model.id,
      stream: true,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${model.provider} returned ${response.status}: ${text.slice(0, 300)}`);
  }

  // The reply arrives as lines like: data: {"choices":[{"delta":{"content":"Hi"}}]}
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const token = JSON.parse(data).choices?.[0]?.delta?.content;
        if (token) {
          full += token;
          onToken(token);
        }
      } catch {
        // ignore partial / keep-alive lines
      }
    }
  }
  return full;
}
