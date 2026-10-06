// Shared by the web server and the terminal app.
// Everything goes through Groq, which speaks the OpenAI-compatible format.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// Settings saved by `tinker` on first run (used when installed from GitHub).
export const USER_ENV_PATH = join(homedir(), ".tinker", ".env");

// Load .env files into process.env. The project folder wins over the home folder.
for (const envPath of [join(dirname(fileURLToPath(import.meta.url)), "..", ".env"), USER_ENV_PATH]) {
  if (existsSync(envPath)) process.loadEnvFile(envPath);
}

export const DEFAULT_MODEL = "qwen/qwen3.8-27b";

export const SYSTEM_PROMPT =
  "You are Tinker, a sharp, friendly AI agent. You help people write and debug code, " +
  "solve problems step by step, and automate tasks. Be concise. Use Markdown and fenced " +
  "code blocks with a language tag. When unsure, say so.";

const BASE_URL = "https://api.groq.com/openai/v1";

export function isConfigured() {
  return Boolean(process.env.GROQ_API_KEY);
}

// Groq's model list also has speech (whisper, orpheus) and safety-filter (guard) models.
// Those can't chat, so we hide them. New Groq chat models appear automatically.
const NOT_CHAT = /whisper|orpheus|guard|tts/i;
let cache = [];

export async function getModels() {
  if (cache.length) return cache;
  if (!isConfigured()) return [];
  try {
    const response = await fetch(`${BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return [];
    const { data = [] } = await response.json();
    cache = data
      .filter((m) => m.active !== false && !NOT_CHAT.test(m.id))
      .sort((a, b) => (a.id === DEFAULT_MODEL ? -1 : b.id === DEFAULT_MODEL ? 1 : a.id.localeCompare(b.id)))
      .map((m) => ({ id: m.id, label: m.id, provider: "groq", note: m.owned_by }));
    return cache;
  } catch {
    return []; // no internet or Groq is down
  }
}

// Sends the conversation to the AI and calls onToken for each piece of text
// as it streams in. Resolves with the full reply.
export async function streamChat({ modelId, messages, onToken, signal }) {
  const model = (await getModels()).find((m) => m.id === modelId);
  if (!model) throw new Error(`Unknown model "${modelId}".`);

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set. Add it to tinker/.env and restart.");

  const response = await fetch(`${BASE_URL}/chat/completions`, {
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
