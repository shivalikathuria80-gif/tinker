// Connectors = tools the AI can choose to call: read a web page, read a GitHub repo,
// search the web, or use any tool from a remote MCP server.

import { lookup } from "node:dns/promises";

const MAX_CHARS = 6000; // keep tool results small: the free Groq tier allows only a few thousand tokens per minute

export const CONNECTORS = [
  { id: "web", label: "Web pages", description: "Reads any link you share" },
  { id: "github", label: "GitHub", description: "Reads public repos: README, file list, files" },
  { id: "search", label: "Web search", description: "Searches the internet (GPT-OSS models only)" },
  { id: "code", label: "Run code", description: "Runs Python to test code, do math and analyse data (GPT-OSS models only)" },
];

// ---------- Safety: only allow public internet addresses ----------
// The hosted server must not be usable to reach localhost or private networks.
// ponytail: checks DNS once before fetching (not rebinding-proof); use an egress proxy if this becomes a target.

function isPrivateIp(ip) {
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  if (ip.includes(":")) return ip === "::1" || ip === "::" || /^f[cd]|^fe80/i.test(ip);
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

async function safeFetch(rawUrl, options = {}) {
  let url = new URL(rawUrl);
  for (let hop = 0; hop < 4; hop++) {
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http(s) links are allowed.");
    if (process.env.TINKER_ALLOW_LOCAL !== "1") {
      const { address } = await lookup(url.hostname);
      if (isPrivateIp(address)) throw new Error("That address is private and can't be used.");
    }
    const response = await fetch(url, { ...options, redirect: "manual", signal: AbortSignal.timeout(15000) });
    const next = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && next) {
      url = new URL(next, url);
      continue;
    }
    return response;
  }
  throw new Error("Too many redirects.");
}

function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const clip = (text) => (text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + "\n…(cut off)" : text);

// ---------- Built-in tools ----------

const BUILT_IN = {
  web: [
    {
      name: "read_webpage",
      description: "Read the text of a public web page.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      status: (a) => `Reading ${a.url}`,
      async run({ url }) {
        const response = await safeFetch(url, { headers: { "User-Agent": "TinkerBot/1.0" } });
        if (!response.ok) return `Could not read the page (HTTP ${response.status}).`;
        const type = response.headers.get("content-type") || "";
        const body = await response.text();
        return clip(type.includes("html") ? htmlToText(body) : body);
      },
    },
  ],
  github: [
    {
      name: "read_github_repo",
      description: "Get the README and file list of a public GitHub repository.",
      parameters: { type: "object", properties: { repo: { type: "string", description: "owner/name" } }, required: ["repo"] },
      status: (a) => `Opening GitHub repo ${a.repo}`,
      async run({ repo }) {
        const api = `https://api.github.com/repos/${repo.replace(/^https?:\/\/github\.com\//, "")}`;
        const headers = { "User-Agent": "TinkerBot/1.0" };
        const [readme, tree] = await Promise.all([
          fetch(`${api}/readme`, { headers: { ...headers, Accept: "application/vnd.github.raw" } }),
          fetch(`${api}/git/trees/HEAD?recursive=1`, { headers }),
        ]);
        if (!tree.ok) return `Could not open the repo (HTTP ${tree.status}). Is it public and spelled owner/name?`;
        const files = (await tree.json()).tree.filter((f) => f.type === "blob").map((f) => f.path);
        return clip(`FILES (${files.length}):\n${files.slice(0, 300).join("\n")}\n\nREADME:\n${readme.ok ? await readme.text() : "(none)"}`);
      },
    },
    {
      name: "read_github_file",
      description: "Read one file from a public GitHub repository.",
      parameters: {
        type: "object",
        properties: { repo: { type: "string", description: "owner/name" }, path: { type: "string" } },
        required: ["repo", "path"],
      },
      status: (a) => `Reading ${a.path} from ${a.repo}`,
      async run({ repo, path }) {
        const response = await fetch(`https://raw.githubusercontent.com/${repo}/HEAD/${path}`);
        return response.ok ? clip(await response.text()) : `Could not read that file (HTTP ${response.status}).`;
      },
    },
  ],
  search: [], // handled by Groq itself (browser_search), see providers.js
  code: [], // handled by Groq itself (code_interpreter), see providers.js
};

// ---------- MCP (remote servers over HTTP) ----------
// Speaks just enough of the MCP "Streamable HTTP" protocol: initialize, tools/list, tools/call.

async function mcpCall(server, session, method, params) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(server.token ? { Authorization: `Bearer ${server.token}` } : {}),
    ...(session.id ? { "Mcp-Session-Id": session.id } : {}),
  };
  const isNotification = method.startsWith("notifications/");
  const body = { jsonrpc: "2.0", method, params, ...(isNotification ? {} : { id: ++session.counter }) };
  const response = await safeFetch(server.url, { method: "POST", headers, body: JSON.stringify(body) });
  session.id = response.headers.get("mcp-session-id") || session.id;
  if (isNotification) return null;
  if (!response.ok) throw new Error(`MCP server "${server.name}" returned HTTP ${response.status}`);
  const text = await response.text();
  const json = (response.headers.get("content-type") || "").includes("event-stream")
    ? JSON.parse(text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).pop())
    : JSON.parse(text);
  if (json.error) throw new Error(`MCP "${server.name}": ${json.error.message}`);
  return json.result;
}

async function loadMcpTools(server, index) {
  const session = { id: null, counter: 0 };
  await mcpCall(server, session, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "tinker", version: "0.1.0" },
  });
  await mcpCall(server, session, "notifications/initialized", {});
  const { tools = [] } = await mcpCall(server, session, "tools/list", {});
  return tools.slice(0, 40).map((tool) => ({
    // Groq tool names may only use letters, numbers, _ and -, max 64 chars
    name: `mcp${index}_${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64),
    description: `[${server.name}] ${tool.description || tool.name}`.slice(0, 1000),
    parameters: tool.inputSchema || { type: "object", properties: {} },
    status: () => `Using ${server.name}: ${tool.name}`,
    async run(args) {
      const result = await mcpCall(server, session, "tools/call", { name: tool.name, arguments: args });
      const text = (result.content || []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
      return clip(text || JSON.stringify(result));
    },
  }));
}

// Builds the tool list for one request. Returns [] when nothing is enabled.
export async function buildTools({ connectors = [], mcp = [] }) {
  const tools = connectors.flatMap((id) => BUILT_IN[id] || []);
  const errors = [];
  for (const [index, server] of mcp.entries()) {
    try {
      tools.push(...(await loadMcpTools(server, index)));
    } catch (error) {
      errors.push(`Couldn't connect to MCP server "${server.name}": ${error.message}`);
    }
  }
  return { tools, errors };
}
