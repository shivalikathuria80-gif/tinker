// A tiny web server using only built-in Node modules (no Express needed).
//   /            -> landing page
//   /app         -> the chat app
//   /api/models  -> list of models (and whether each one has a key set)
//   /api/chat    -> forwards a conversation to the AI and streams the reply back
//   /api/complete -> one non-streamed AI reply, used by the terminal app's own agent loop
//   /api/transcribe -> turns a voice recording into text (Groq Whisper)

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { getModels, DEFAULT_MODEL, SKILLS, isConfigured, streamChat, groqComplete } from "./lib/providers.js";
import { CONNECTORS } from "./lib/connectors.js";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "public");
const PORT = process.env.PORT || 3000;
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("Request too large");
  }
  return JSON.parse(body);
}

// Simple rate limit so one person can't use up the shared Groq key.
// ponytail: in-memory, resets on restart and is per server — swap for Redis or sign-in limits if Tinker grows.
// 60 because one terminal question with tools can take several AI calls.
const LIMIT_PER_MINUTE = 60;
const recentRequests = new Map(); // ip -> timestamps of requests in the last minute

function isRateLimited(req) {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const now = Date.now();
  const times = (recentRequests.get(ip) || []).filter((t) => now - t < 60_000);
  times.push(now);
  recentRequests.set(ip, times);
  return times.length > LIMIT_PER_MINUTE;
}

// A visitor's own Groq key (optional, sent by the web app). Their usage then counts against their
// own Groq limits, so the shared rate limit doesn't apply to them.
function userKey(req) {
  const key = req.headers["x-groq-key"];
  return typeof key === "string" && /^gsk_[A-Za-z0-9]{20,}$/.test(key) ? key : undefined;
}

const limited = (req) => !userKey(req) && isRateLimited(req);

function tooMany(res) {
  res.writeHead(429, { "Content-Type": "text/plain" }).end("Too many messages. Please wait a minute and try again.");
}

// One AI reply with tools, for the terminal app. The terminal runs the tools on the user's own computer.
async function handleComplete(req, res) {
  if (limited(req)) return tooMany(res);
  try {
    const payload = await readJson(req);
    const models = await getModels();
    if (!models.some((m) => m.id === payload.model)) throw new Error("Unknown model");
    const message = await groqComplete({
      model: payload.model,
      messages: (Array.isArray(payload.messages) ? payload.messages : []).slice(-80),
      ...(Array.isArray(payload.tools) && payload.tools.length ? { tools: payload.tools.slice(0, 64), tool_choice: "auto" } : {}),
    }, undefined, userKey(req));
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(message));
  } catch (error) {
    res.writeHead(400, { "Content-Type": "text/plain" }).end(error.message);
  }
}

// Voice input: the browser sends recorded audio, we ask Groq Whisper for the text.
async function handleTranscribe(req, res) {
  if (limited(req)) return tooMany(res);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 10_000_000) return res.writeHead(413).end("Recording too long");
    chunks.push(chunk);
  }
  const form = new FormData();
  form.append("file", new Blob([Buffer.concat(chunks)], { type: req.headers["content-type"] || "audio/webm" }), "voice.webm");
  form.append("model", "whisper-large-v3-turbo");
  const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${userKey(req) || process.env.GROQ_API_KEY}` },
    body: form,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) return res.writeHead(502, { "Content-Type": "text/plain" }).end(result.error?.message || "Transcription failed");
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ text: result.text || "" }));
}

async function handleChat(req, res) {
  if (limited(req)) return tooMany(res);
  let payload;
  try {
    payload = await readJson(req);
  } catch {
    res.writeHead(400).end("Invalid JSON");
    return;
  }

  // Only pass through plain user/assistant text messages (minus our tool status lines).
  const messages = (Array.isArray(payload.messages) ? payload.messages : [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.replace(/^\[\[tool\]\].*\n?/gm, "") }))
    .slice(-40);

  // Skill: a built-in id, or a custom { name, instructions } written by the user.
  const preset = SKILLS.find((s) => s.id === payload.skill?.id);
  const skill = preset || (typeof payload.skill?.instructions === "string"
    ? { name: String(payload.skill.name || "Custom").slice(0, 60), instructions: payload.skill.instructions.slice(0, 4000) }
    : null);
  const connectors = (Array.isArray(payload.connectors) ? payload.connectors : []).filter((id) => CONNECTORS.some((c) => c.id === id));
  const mcp = (Array.isArray(payload.mcp) ? payload.mcp : [])
    .filter((s) => typeof s?.url === "string")
    .slice(0, 5)
    .map((s) => ({ name: String(s.name || "MCP").slice(0, 40), url: s.url, token: typeof s.token === "string" ? s.token : "" }));

  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" });
  const controller = new AbortController();
  res.on("close", () => controller.abort());

  try {
    await streamChat({
      modelId: payload.model || DEFAULT_MODEL,
      messages,
      signal: controller.signal,
      skill,
      connectors,
      mcp,
      apiKey: userKey(req),
      onToken: (token) => res.write(token),
      onStatus: (text) => res.write(`[[tool]] ${text.replace(/\n/g, " ")}\n`),
    });
  } catch (error) {
    if (!controller.signal.aborted) res.write(`\n\n[[error]] ${error.message}`);
  }
  res.end();
}

async function serveFile(pathname, res) {
  const routes = { "/": "/index.html", "/app": "/app.html" };
  const file = normalize(join(PUBLIC_DIR, routes[pathname] || pathname));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const content = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  }
}

async function route(req, res) {
  const { pathname } = new URL(req.url, "http://localhost");
  if (req.method === "POST" && pathname === "/api/chat") return handleChat(req, res);
  if (req.method === "POST" && pathname === "/api/complete") return handleComplete(req, res);
  if (req.method === "POST" && pathname === "/api/transcribe") return handleTranscribe(req, res);
  if (pathname === "/api/models") {
    const list = (await getModels()).map((m) => ({ ...m, ready: isConfigured(m.provider) }));
    res.writeHead(200, { "Content-Type": "application/json" });
    const skills = SKILLS.map(({ id, name, description }) => ({ id, name, description }));
    return res.end(JSON.stringify({ models: list, skills, connectors: CONNECTORS, default: list.some((m) => m.id === DEFAULT_MODEL) ? DEFAULT_MODEL : list[0]?.id }));
  }
  return serveFile(pathname, res);
}

createServer((req, res) => {
  // Safety net: an unexpected error answers 500 instead of crashing the whole server.
  route(req, res).catch((error) => {
    console.error(error);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Something went wrong on the server. Please try again.");
  });
}).listen(PORT, () => {
  console.log(`Tinker is running at http://localhost:${PORT}`);
});
