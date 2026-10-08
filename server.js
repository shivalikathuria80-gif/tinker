// A tiny web server using only built-in Node modules (no Express needed).
//   /            -> landing page
//   /app         -> the chat app
//   /api/models  -> list of models (and whether each one has a key set)
//   /api/chat    -> forwards a conversation to the AI and streams the reply back
//   /api/complete -> one non-streamed AI reply, used by the terminal app's own agent loop
//   /api/transcribe -> turns a voice recording into text (Groq Whisper)
//   /api/title    -> a short title for a new chat, based on its first message
//   /api/speak    -> reads text aloud with ElevenLabs (voice mode)
//   /api/voices   -> the ElevenLabs voices people can pick in Settings

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
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
  ".png": "image/png", ".webmanifest": "application/manifest+json", ".txt": "text/plain", ".xml": "application/xml",
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
// Voice mode: turns Tinker's answer into speech with ElevenLabs and streams the MP3 back.
// The ElevenLabs key stays on the server. Without a key, the web app uses the browser's own voice.
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // "Rachel", a free premade voice
const MAX_SPEAK_CHARS = 600; // voice answers are short; this protects the monthly ElevenLabs credits

async function handleSpeak(req, res) {
  if (!process.env.ELEVENLABS_API_KEY) return res.writeHead(503, { "Content-Type": "text/plain" }).end("ElevenLabs is not set up");
  const wait = await limited(req);
  if (wait) return tooMany(res, wait);
  const { text = "", voiceId } = await readJson(req);
  const clean = String(text).trim().slice(0, MAX_SPEAK_CHARS);
  // A voice picked in Settings (ElevenLabs voice IDs are short letters/numbers), otherwise the default.
  const voice = typeof voiceId === "string" && /^[A-Za-z0-9]{10,40}$/.test(voiceId) ? voiceId : ELEVENLABS_VOICE_ID;
  if (!clean) return res.writeHead(400).end("Nothing to say");

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voice}/stream?output_format=mp3_44100_64`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "xi-api-key": process.env.ELEVENLABS_API_KEY },
      body: JSON.stringify({ text: clean, model_id: "eleven_flash_v2_5" }),
    },
  );
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200);
    console.error("ElevenLabs error", response.status, detail);
    return res.writeHead(502, { "Content-Type": "text/plain" }).end(`ElevenLabs returned ${response.status}`);
  }
  res.writeHead(200, { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" });
  for await (const chunk of response.body) res.write(chunk); // stream: playback can start before it's all generated
  res.end();
}

// The voices on the ElevenLabs account (cached for an hour; listing voices costs no credits).
let voicesCache = { list: null, expires: 0 };
async function handleVoices(req, res) {
  if (!process.env.ELEVENLABS_API_KEY) return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ voices: [] }));
  if (!voicesCache.list || Date.now() > voicesCache.expires) {
    const response = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY } });
    if (!response.ok) {
      // e.g. 401: the key may speak but not list voices (ElevenLabs key permission "Voices: Read").
      // Still offer the default voice so people can choose between it and the browser voice.
      console.error("ElevenLabs voices list failed", response.status);
      const fallback = [{ id: ELEVENLABS_VOICE_ID, name: "ElevenLabs voice", description: "Natural AI voice", preview: null, default: true }];
      return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ voices: fallback, limited: true }));
    }
    const { voices = [] } = await response.json();
    voicesCache = {
      expires: Date.now() + 3_600_000,
      list: voices.slice(0, 40).map((v) => ({
        id: v.voice_id,
        name: v.name,
        description: [v.labels?.gender, v.labels?.accent, v.labels?.description || v.labels?.descriptive].filter(Boolean).join(" · "),
        preview: v.preview_url || null,
        default: v.voice_id === ELEVENLABS_VOICE_ID,
      })),
    };
  }
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ voices: voicesCache.list }));
}

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

// ---------- Terminal sign-in (tinker login) ----------
// 1. The terminal asks for a code.  2. You approve that code in the browser while signed in.
// 3. The terminal picks up your sign-in key once (it's then deleted here). Codes expire after 5 minutes.
// ponytail: kept in memory, so a server restart cancels logins in progress (just run tinker login again).
const cliLogins = new Map(); // code → { pollToken, created, approved: { refreshToken, email } | null }

function makeCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I, so it's easy to compare by eye
  const pick = () => Array.from(randomBytes(4), (b) => letters[b % letters.length]).join("");
  return `${pick()}-${pick()}`;
}

function cleanupCliLogins() {
  for (const [code, entry] of cliLogins) if (Date.now() - entry.created > 5 * 60_000) cliLogins.delete(code);
}

async function handleCliLogin(req, res, step) {
  cleanupCliLogins();
  const json = (status, data) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(data));
  if (step === "start") {
    if (cliLogins.size > 1000) return json(503, { error: "Too many logins in progress. Try again in a minute." });
    const code = makeCode();
    const pollToken = randomBytes(24).toString("hex");
    cliLogins.set(code, { pollToken, created: Date.now(), approved: null });
    return json(200, { code, pollToken });
  }
  const body = await readJson(req).catch(() => ({}));
  const entry = cliLogins.get(String(body.code || "").toUpperCase());
  if (step === "approve") {
    // Only a signed-in browser can approve: we check its Firebase token.
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    const uid = await verifyIdToken(token, FIREBASE_PROJECT_ID);
    if (!uid) return json(401, { error: "Please sign in first." });
    if (!entry) return json(404, { error: "That code has expired or doesn't exist. Run tinker login again." });
    if (typeof body.refreshToken !== "string" || body.refreshToken.length < 20) return json(400, { error: "Missing sign-in details." });
    entry.approved = { refreshToken: body.refreshToken, email: String(body.email || "") };
    return json(200, { ok: true });
  }
  if (step === "poll") {
    if (!entry || entry.pollToken !== body.pollToken) return json(404, { error: "expired" });
    if (!entry.approved) return json(202, { waiting: true });
    cliLogins.delete(body.code.toUpperCase()); // hand it over once, then forget it
    return json(200, entry.approved);
  }
  json(404, { error: "Unknown step" });
}

// Models that can look at images. ponytail: hand-kept list, because Groq's model list doesn't say which can see.
const VISION_MODELS = ["qwen/qwen3.8-27b"];

// Accepts up to 3 images as data URLs (PNG, JPEG, WebP or GIF), each under ~4 MB.
function validImages(images) {
  if (!Array.isArray(images)) return [];
  return images
    .filter((url) => typeof url === "string" && url.length < 4_000_000 && /^data:image\/(png|jpeg|webp|gif);base64,/.test(url))
    .slice(0, 3);
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
  const raw = (Array.isArray(payload.messages) ? payload.messages : [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-40);
  const lastIndex = raw.length - 1;
  let hasImages = false;
  const messages = raw.map((m, i) => {
    const content = m.content.replace(/^\[\[tool\]\].*\n?/gm, "");
    const images = validImages(m.images);
    if (!images.length) return { role: m.role, content };
    // Images: only the newest message sends them (keeps requests small); older ones get a short note.
    if (m.role !== "user" || i !== lastIndex) return { role: m.role, content: `${content}\n[An image was attached here earlier]` };
    hasImages = true;
    return { role: "user", content: [{ type: "text", text: content }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))] };
  });

  // Not every model can see images. If needed, answer with one that can, and say so.
  let modelId = payload.model || DEFAULT_MODEL;
  let switchedModel = null;
  if (hasImages && !VISION_MODELS.includes(modelId)) {
    const available = (await getModels()).map((m) => m.id);
    switchedModel = VISION_MODELS.find((id) => available.includes(id));
    if (!switchedModel) {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("[[error]] None of the available models can look at images right now.");
      return;
    }
    modelId = switchedModel;
  }

  // Skill: a built-in id, or a custom { name, instructions } written by the user.
  const preset = SKILLS.find((s) => s.id === payload.skill?.id);
  let skill = preset || (typeof payload.skill?.instructions === "string"
    ? { name: String(payload.skill.name || "Custom").slice(0, 60), instructions: payload.skill.instructions.slice(0, 4000) }
    : null);
  // Voice mode: the answer will be read aloud, so keep it short and speakable.
  if (payload.voice === true) {
    const voiceRules = "The user is talking to you by voice and will HEAR your answer read aloud. " +
      "Answer in 1–3 short, natural spoken sentences. No markdown, headings, lists, tables or emoji. " +
      "Only write code if asked; if you do, put it in a code block and say \"I've put the code in the chat.\"";
    skill = { name: skill?.name || "Voice", instructions: [skill?.instructions, voiceRules].filter(Boolean).join("\n\n") };
  }
  const connectors = (Array.isArray(payload.connectors) ? payload.connectors : []).filter((id) => CONNECTORS.some((c) => c.id === id));
  const mcp = (Array.isArray(payload.mcp) ? payload.mcp : [])
    .filter((s) => typeof s?.url === "string")
    .slice(0, 5)
    .map((s) => ({ name: String(s.name || "MCP").slice(0, 40), url: s.url, token: typeof s.token === "string" ? s.token : "" }));

  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" });
  if (switchedModel) res.write(`[[tool]] Using ${switchedModel} to look at the image\n`);
  const controller = new AbortController();
  res.on("close", () => controller.abort());

  try {
    await streamChat({
      modelId,
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
  const routes = {
    "/": "/index.html", "/app": "/app.html", "/signin": "/signin.html", "/settings": "/settings.html",
    "/privacy": "/privacy.html", "/terms": "/terms.html", "/cli-login": "/cli-login.html",
  };
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
    // Friendly "page not found" page for browsers; plain text for everything else.
    const page = await readFile(join(PUBLIC_DIR, "404.html")).catch(() => "Not found");
    res.writeHead(404, { "Content-Type": "text/html" }).end(page);
  }
}

async function route(req, res) {
  const { pathname } = new URL(req.url, "http://localhost");
  if (req.method === "POST" && pathname === "/api/chat") return handleChat(req, res);
  if (req.method === "POST" && pathname === "/api/complete") return handleComplete(req, res);
  if (req.method === "POST" && pathname === "/api/transcribe") return handleTranscribe(req, res);
  if (req.method === "POST" && pathname === "/api/title") return handleTitle(req, res);
  if (req.method === "POST" && pathname === "/api/speak") return handleSpeak(req, res);
  if (pathname === "/api/voices") return handleVoices(req, res);
  const cliStep = pathname.match(/^\/api\/cli-login\/(start|approve|poll)$/)?.[1];
  if (req.method === "POST" && cliStep) return handleCliLogin(req, res, cliStep);
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
