// Shared by the web server and the terminal app.
// Everything goes through Groq, which speaks the OpenAI-compatible format.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { buildTools } from "./connectors.js";

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

// Built-in skills: extra instructions that change how Tinker behaves.
export const SKILLS = [
  { id: "debugger", name: "Debugger", description: "Finds the root cause of bugs",
    instructions: "Act as a debugging expert. Ask for the exact error if missing. Find the root cause before suggesting a fix, explain why it happened, then give the smallest fix." },
  { id: "reviewer", name: "Code Reviewer", description: "Reviews code for bugs and clarity",
    instructions: "Act as a senior code reviewer. Check correctness, security, readability and performance. List issues by severity with concrete fixes. Praise what is good briefly." },
  { id: "tests", name: "Test Writer", description: "Writes tests for your code",
    instructions: "Act as a test engineer. Write focused, runnable tests covering normal cases, edge cases and errors. Use the project's language and a common test framework." },
  { id: "explain", name: "Explain Simply", description: "Beginner-friendly explanations",
    instructions: "Explain like a patient teacher talking to a beginner. Avoid jargon or define it. Use short steps, small examples and analogies." },
  { id: "architect", name: "Architect", description: "Plans features and project structure",
    instructions: "Act as a pragmatic software architect. Break the request into small steps, choose the simplest design that works, and point out trade-offs and risks." },
];

export function systemPrompt(skill) {
  if (!skill?.instructions) return SYSTEM_PROMPT;
  return `${SYSTEM_PROMPT}\n\nActive skill — ${skill.name || "Custom"}:\n${skill.instructions}`;
}

async function groq(body, signal) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set. Add it to tinker/.env and restart.");
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`groq returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response;
}

// One non-streamed reply from Groq (used by the agent loop). Returns the assistant message.
export async function groqComplete(body, signal) {
  const response = await groq({ ...body, stream: false }, signal);
  return (await response.json()).choices[0].message;
}

// Web search and code running are done by Groq itself, but only GPT-OSS models support them.
export function builtInTools(modelId, connectors, onStatus) {
  const wanted = [["search", "browser_search", "Web search"], ["code", "code_interpreter", "Run code"]]
    .filter(([id]) => connectors.includes(id));
  if (!wanted.length) return [];
  if (!modelId.startsWith("openai/gpt-oss")) {
    onStatus(`${wanted.map((w) => w[2]).join(" and ")} only ${wanted.length > 1 ? "work" : "works"} with the GPT-OSS models — switch model to use ${wanted.length > 1 ? "them" : "it"}`);
    return [];
  }
  wanted.forEach((w) => onStatus(`${w[2]} is on`));
  return wanted.map(([, type]) => ({ type }));
}

// Sends the conversation to the AI and calls onToken for each piece of text.
// With connectors enabled, the AI can call tools first (onStatus reports each one).
export async function streamChat({ modelId, messages, onToken, onStatus = () => {}, signal, skill, connectors = [], mcp = [] }) {
  const model = (await getModels()).find((m) => m.id === modelId);
  if (!model) throw new Error(`Unknown model "${modelId}".`);
  const conversation = [{ role: "system", content: systemPrompt(skill) }, ...messages];

  const { tools, errors } = await buildTools({ connectors, mcp });
  errors.forEach((e) => onStatus(e));
  const builtIns = builtInTools(model.id, connectors, onStatus);
  if (tools.length || builtIns.length) {
    const complete = (body) => groqComplete(body, signal);
    return agentLoop({ modelId: model.id, conversation, tools, builtIns, complete, onToken, onStatus });
  }

  const response = await groq({ model: model.id, stream: true, messages: conversation }, signal);

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

// The agent loop: ask the model, run any tools it asks for, give it the results, repeat.
// `complete` sends one request to the model — directly to Groq, or through the Tinker server (terminal app).
// ponytail: answers arrive in one piece (not streamed) when tools are on; stream tool-call deltas if that feels slow.
export async function agentLoop({ modelId, conversation, tools, builtIns = [], complete, onToken, onStatus, maxSteps = 8 }) {
  const definitions = [
    ...tools.map(({ name, description, parameters }) => ({ type: "function", function: { name, description, parameters } })),
    ...builtIns,
  ];
  for (let step = 0; step < maxSteps; step++) {
    const message = await complete({ model: modelId, messages: conversation, tools: definitions, tool_choice: "auto" });
    if (!message.tool_calls?.length) {
      const answer = (message.content || "").replace(/【[^】]*】/g, ""); // drop search citation codes
      onToken(answer);
      return answer;
    }
    conversation.push({ role: "assistant", content: message.content || "", tool_calls: message.tool_calls });
    for (const call of message.tool_calls) {
      const tool = tools.find((t) => t.name === call.function.name);
      let result;
      try {
        const args = JSON.parse(call.function.arguments || "{}");
        onStatus(tool ? tool.status(args) : `Unknown tool ${call.function.name}`);
        result = tool ? await tool.run(args) : "This tool does not exist.";
      } catch (error) {
        result = `Tool failed: ${error.message}`;
      }
      conversation.push({ role: "tool", tool_call_id: call.id, content: String(result) });
    }
  }
  const final = "I used several tools but couldn't finish. Try asking a narrower question.";
  onToken(final);
  return final;
}
