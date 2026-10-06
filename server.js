// A tiny web server using only built-in Node modules (no Express needed).
//   /            -> landing page
//   /app         -> the chat app
//   /api/models  -> list of models (and whether each one has a key set)
//   /api/chat    -> forwards a conversation to the AI and streams the reply back

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { getModels, DEFAULT_MODEL, isConfigured, streamChat } from "./lib/providers.js";

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

async function handleChat(req, res) {
  let payload;
  try {
    payload = await readJson(req);
  } catch {
    res.writeHead(400).end("Invalid JSON");
    return;
  }

  // Only pass through plain user/assistant text messages.
  const messages = (Array.isArray(payload.messages) ? payload.messages : [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-40);

  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" });
  const controller = new AbortController();
  res.on("close", () => controller.abort());

  try {
    await streamChat({
      modelId: payload.model || DEFAULT_MODEL,
      messages,
      signal: controller.signal,
      onToken: (token) => res.write(token),
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
    return res.end(JSON.stringify({ models: list, default: list.some((m) => m.id === DEFAULT_MODEL) ? DEFAULT_MODEL : list[0]?.id }));
  }
  return serveFile(pathname, res);
}).listen(PORT, () => {
  console.log(`Tinker is running at http://localhost:${PORT}`);
});
