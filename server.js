// A tiny web server using only built-in Node modules (no Express needed).
//   /            -> landing page
//   /app         -> the chat app
//   /api/models  -> list of models (and whether each one has a key set)
//   /api/chat    -> forwards a conversation to the AI and streams the reply back

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { getModels, DEFAULT_MODEL, SKILLS, isConfigured, streamChat } from "./lib/providers.js";
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
const LIMIT_PER_MINUTE = 20;
const recentRequests = new Map(); // ip -> timestamps of requests in the last minute

function isRateLimited(req) {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const now = Date.now();
  const times = (recentRequests.get(ip) || []).filter((t) => now - t < 60_000);
  times.push(now);
  recentRequests.set(ip, times);
  return times.length > LIMIT_PER_MINUTE;
}

async function handleChat(req, res) {
  if (isRateLimited(req)) {
    res.writeHead(429, { "Content-Type": "text/plain" }).end("Too many messages. Please wait a minute and try again.");
    return;
  }
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

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  if (req.method === "POST" && pathname === "/api/chat") return handleChat(req, res);
  if (pathname === "/api/models") {
    const list = (await getModels()).map((m) => ({ ...m, ready: isConfigured(m.provider) }));
    res.writeHead(200, { "Content-Type": "application/json" });
    const skills = SKILLS.map(({ id, name, description }) => ({ id, name, description }));
    return res.end(JSON.stringify({ models: list, skills, connectors: CONNECTORS, default: list.some((m) => m.id === DEFAULT_MODEL) ? DEFAULT_MODEL : list[0]?.id }));
  }
  return serveFile(pathname, res);
}).listen(PORT, () => {
  console.log(`Tinker is running at http://localhost:${PORT}`);
});
