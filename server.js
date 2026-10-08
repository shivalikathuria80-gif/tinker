// A tiny web server using only built-in Node modules (no Express needed).
//   /            -> landing page
//   /app         -> the chat app
//   /api/models  -> list of models (and whether each one has a key set)
//   /api/chat    -> forwards a conversation to the AI and streams the reply back
//   /api/complete -> one non-streamed AI reply, used by the terminal app's own agent loop
//   /api/transcribe -> turns a voice recording into text (Groq Whisper)
//   /api/title    -> a short title for a new chat, based on its first message

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { getModels, DEFAULT_MODEL, SKILLS, isConfigured, streamChat, groqComplete, cleanTitle } from "./lib/providers.js";
import { CONNECTORS } from "./lib/connectors.js";
import { verifyIdToken } from "./lib/auth.js";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "public");
const PORT = process.env.PORT || 3000;
const TYPES = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml",
  ".png": "image/png", ".webmanifest": "application/manifest+json",
};

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
// Signed-in people get more than anonymous visitors. Generous because one terminal question
// with tools can take several AI calls.
const LIMITS_PER_MINUTE = { signedIn: 90, anonymous: 40 };
const recentRequests = new Map(); // "user:<uid>" or "ip:<address>" -> timestamps in the last minute
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "tinkeraidev";

// Returns 0 if the request may go ahead, otherwise how many seconds until it can.
async function secondsUntilAllowed(req) {
  // Who is this? A verified Firebase sign-in token → their user id; otherwise their IP address.
  const token = (req.headers.authorization || "").replace(/^Bearer /, "");
  const uid = token ? await verifyIdToken(token, FIREBASE_PROJECT_ID) : null;
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const who = uid ? `user:${uid}` : `ip:${ip}`;
  const limit = uid ? LIMITS_PER_MINUTE.signedIn : LIMITS_PER_MINUTE.anonymous;

  const now = Date.now();
  // ponytail: crude memory cap; a busy server would use Redis or Firestore counters instead.
  if (recentRequests.size > 20_000) recentRequests.clear();
  const times = (recentRequests.get(who) || []).filter((t) => now - t < 60_000);
  if (times.length >= limit) return Math.ceil((times[0] + 60_000 - now) / 1000);
  times.push(now);
  recentRequests.set(who, times);
  return 0;
}

// A visitor's own Groq key (optional, sent by the web app). Their usage then counts against their
// own Groq limits, so the shared rate limit doesn't apply to them.
function userKey(req) {
  const key = req.headers["x-groq-key"];
  return typeof key === "string" && /^gsk_[A-Za-z0-9]{20,}$/.test(key) ? key : undefined;
}

const limited = async (req) => (userKey(req) ? 0 : secondsUntilAllowed(req));

// The web app looks for "Ready again in Ns" to show a countdown.
function tooMany(res, seconds) {
  res.writeHead(429, { "Content-Type": "text/plain", "Retry-After": String(seconds) })
    .end(`Free limit reached. Ready again in ${seconds}s.`);
}

// One AI reply with tools, for the terminal app. The terminal runs the tools on the user's own computer.
async function handleComplete(req, res) {
  const wait = await limited(req);
  if (wait) return tooMany(res, wait);
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
  const wait = await limited(req);
  if (wait) return tooMany(res, wait);
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

// Auto-naming: a small, fast model reads the start of a chat and suggests a 3–6 word title.
async function handleTitle(req, res) {
  const wait = await limited(req);
  if (wait) return tooMany(res, wait);
  try {
    const { question = "", answer = "" } = await readJson(req);
    const message = await groqComplete({
      model: "openai/gpt-oss-20b",
      reasoning_effort: "low",
      max_tokens: 300,
      messages: [
        { role: "system", content: "Write a short title (3 to 6 words) for this chat. Reply with the title only: no quotes, no ending punctuation." },
        { role: "user", content: `Question: ${String(question).slice(0, 1500)}\n\nStart of the answer: ${String(answer).slice(0, 500)}` },
      ],
    }, undefined, userKey(req));
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ title: cleanTitle(message.content) }));
  } catch (error) {
    res.writeHead(502, { "Content-Type": "text/plain" }).end(error.message);
  }
}

async function handleChat(req, res) {
  const wait = await limited(req);
  if (wait) return tooMany(res, wait);
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
  const routes = { "/": "/index.html", "/app": "/app.html", "/signin": "/signin.html" };
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
  if (req.method === "POST" && pathname === "/api/title") return handleTitle(req, res);
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
