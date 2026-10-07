// Chat app logic. Chats are saved in localStorage (this browser only) for now.
// Later, when we add sign-in, they can move to a database.

const STORAGE_KEY = "tinker.chats";

const els = {
  app: document.getElementById("app"),
  list: document.getElementById("history-list"),
  messages: document.getElementById("messages"),
  form: document.getElementById("composer"),
  input: document.getElementById("input"),
  send: document.getElementById("send"),
  model: document.getElementById("model"),
  menu: document.getElementById("menu"),
  scrim: document.getElementById("scrim"),
};

let chats = loadChats();
let activeId = null;
let isStreaming = false;

// ---------- Account: Google sign-in + chats saved to your account (Firebase) ----------
// Signed out: chats stay in this browser only. Signed in: chats are saved to your account and
// show up on every device. Signing in also gives you higher free limits.

let cloudUser = null;
const syncedVersions = new Map(); // chat id → the version last saved to the cloud
let syncTimer = null;

// Headers sent with each request: your sign-in token (for per-person limits) and/or your own Groq key.
async function authHeaders() {
  const headers = { ...keyHeader() };
  const token = cloudUser ? await window.tinkerCloud.idToken() : null;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

// Uploads chats that changed since the last upload (waits 1.5s so typing/streaming isn't uploaded constantly).
function scheduleCloudSync() {
  if (!cloudUser) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    for (const chat of chats) {
      const version = JSON.stringify(chat);
      if (syncedVersions.get(chat.id) === version) continue;
      if (version.length > 900_000) {
        toast(`"${chat.title}" is too big to save to your account (Firestore's 1 MB limit). It stays in this browser.`);
        syncedVersions.set(chat.id, version);
        continue;
      }
      chat.updated = Date.now();
      try {
        await window.tinkerCloud.saveChat(chat);
        syncedVersions.set(chat.id, JSON.stringify(chat));
      } catch {
        toast("Couldn't save to your account right now. Your chats are still in this browser.");
        return;
      }
    }
  }, 1500);
}

// After signing in: combine this browser's chats with the account's chats (newest version wins).
async function mergeCloudChats() {
  try {
    const remote = await window.tinkerCloud.listChats();
    const byId = new Map(chats.map((c) => [c.id, c]));
    for (const chat of remote) {
      const local = byId.get(chat.id);
      if (!local || (chat.updated || 0) > (local.updated || 0)) byId.set(chat.id, chat);
      syncedVersions.set(chat.id, JSON.stringify(chat));
    }
    chats = [...byId.values()].sort((a, b) => (b.updated || 0) - (a.updated || 0));
    saveChats(); // uploads chats that only existed in this browser
    renderHistory();
    renderMessages();
  } catch {
    toast("Couldn't load your saved chats. Check your internet and refresh.");
  }
}

function renderAccount() {
  const button = document.getElementById("sign-in");
  const label = cloudUser ? (cloudUser.displayName || cloudUser.email || "Account").split(" ")[0] : "Sign in";
  button.lastChild.textContent = ` ${label}`;
  button.title = cloudUser ? `Signed in as ${cloudUser.email}. Click to sign out.` : "Sign in with Google to save chats to your account";
  button.setAttribute("aria-label", cloudUser ? `Signed in as ${cloudUser.email}. Sign out` : "Sign in with Google");
}

function setupAccount() {
  const cloud = window.tinkerCloud;
  document.getElementById("sign-in").onclick = async () => {
    if (!cloud) return toast("Sign-in couldn't load. Check your internet and refresh.");
    if (!cloudUser) {
      try {
        await cloud.signIn();
      } catch (error) {
        if (error?.code !== "auth/popup-closed-by-user") toast(`Sign-in failed: ${error?.code || error?.message}`);
      }
      return;
    }
    if (!confirm(`Sign out of ${cloudUser.email}? Your chats stay saved in your account.`)) return;
    await cloud.signOut();
  };
  cloud.onUserChange(async (user) => {
    const wasSignedIn = Boolean(cloudUser);
    cloudUser = user;
    renderAccount();
    if (user) {
      await mergeCloudChats();
    } else if (wasSignedIn) {
      // Signed out: remove this account's chats from this browser (they're safe in the account).
      chats = [];
      activeId = null;
      syncedVersions.clear();
      saveChats();
      renderHistory();
      renderMessages();
    }
  });
}
if (window.tinkerCloud) setupAccount();
else addEventListener("tinker-cloud-ready", setupAccount, { once: true });

function loadChats() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveChats() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(chats));
  } catch {
    // storage full or blocked — the chat still works, it just won't be saved
  }
  scheduleCloudSync();
}

const activeChat = () => chats.find((c) => c.id === activeId);

// ---------- Rendering ----------

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

// A small Markdown renderer: code blocks, inline code, bold, headings, lists, paragraphs.
function renderMarkdown(text) {
  let thinking = "";
  // Qwen 3 wraps its reasoning in <think>…</think>; show it as a collapsible block.
  text = text.replace(/<think>([\s\S]*?)(<\/think>|$)/, (_, inner) => {
    thinking = inner.trim();
    return "";
  });

  const parts = text.split(/```(\w*)\n?([\s\S]*?)(?:```|$)/g);
  let html = "";
  for (let i = 0; i < parts.length; i += 3) {
    html += renderProse(parts[i]);
    if (parts[i + 2] !== undefined) {
      const lang = parts[i + 1] ? ` class="language-${escapeHtml(parts[i + 1])}"` : "";
      html += `<pre><code${lang}>${escapeHtml(parts[i + 2].replace(/\n$/, ""))}</code></pre>`;
    }
  }
  if (thinking) {
    html = `<details><summary>Thinking</summary>${renderProse(thinking)}</details>` + html;
  }
  return html;
}

// Inline formatting inside a line: `code` and **bold** (text is escaped first).
const inline = (text) => escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());

function renderTable(header, rows) {
  const head = cells(header).map((c) => `<th scope="col">${inline(c)}</th>`).join("");
  const body = rows.map((row) => `<tr>${cells(row).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("");
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderBlock(block) {
  if (!block.trim()) return "";
  const lines = block.split("\n");
  // A Markdown table: a header row, a divider row like |---|---|, then data rows.
  const divider = lines.findIndex((line, i) => i > 0 && TABLE_DIVIDER.test(line) && lines[i - 1].includes("|"));
  if (divider > 0) {
    let end = divider + 1;
    while (end < lines.length && lines[end].includes("|")) end++;
    return renderBlock(lines.slice(0, divider - 1).join("\n")) +
      renderTable(lines[divider - 1], lines.slice(divider + 1, end)) +
      renderBlock(lines.slice(end).join("\n"));
  }
  const heading = block.match(/^(#{1,4})\s+(.*)/);
  if (heading) return `<h${heading[1].length + 2} class="md-heading">${inline(heading[2])}</h${heading[1].length + 2}>${renderBlock(block.split("\n").slice(1).join("\n"))}`;
  if (/^(\s*[-*]|\s*\d+\.)\s/.test(block)) {
    const items = lines.map((line) => `<li>${inline(line.replace(/^\s*([-*]|\d+\.)\s/, ""))}</li>`);
    return /^\s*\d+\./.test(block) ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`;
  }
  return `<p>${lines.map(inline).join("<br>")}</p>`;
}

function renderProse(text) {
  return text.trim().split(/\n{2,}/).map(renderBlock).join("");
}

function renderHistory() {
  if (chats.length === 0) {
    els.list.innerHTML = `<p class="history-empty">No chats yet. Start one!</p>`;
    return;
  }
  // Search matches chat titles and message text.
  const query = document.getElementById("chat-search").value.trim().toLowerCase();
  const matches = chats.filter((chat) =>
    !query || chat.title.toLowerCase().includes(query) || chat.messages.some((m) => (m.display ?? m.content).toLowerCase().includes(query)));
  if (matches.length === 0) {
    els.list.innerHTML = `<p class="history-empty">No chats match "${escapeHtml(query)}".</p>`;
    return;
  }
  els.list.innerHTML = "";
  for (const chat of matches) {
    const row = document.createElement("div");
    row.className = "chat-item" + (chat.id === activeId ? " active" : "");
    row.innerHTML = `
      <button class="open" type="button" ${chat.id === activeId ? 'aria-current="true"' : ""}></button>
      <button class="del rename" type="button">
        <svg class="icon" style="width:14px;height:14px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"/></svg>
      </button>
      <button class="del" type="button">✕</button>`;
    row.querySelector(".open").textContent = chat.title;
    row.querySelector(".open").title = chat.title;
    row.querySelector(".open").onclick = () => openChat(chat.id);
    row.querySelector(".rename").setAttribute("aria-label", `Rename "${chat.title}"`);
    row.querySelector(".rename").onclick = () => renameChat(chat.id);
    row.querySelector(".del:not(.rename)").setAttribute("aria-label", `Delete "${chat.title}"`);
    row.querySelector(".del:not(.rename)").onclick = () => deleteChat(chat.id);
    els.list.appendChild(row);
  }
}

function renameChat(id) {
  const chat = chats.find((c) => c.id === id);
  const title = prompt("Rename chat:", chat.title)?.trim();
  if (!title) return;
  chat.title = title.slice(0, 80);
  chat.renamed = true; // auto-naming won't touch it any more
  saveChats();
  renderHistory();
}

document.getElementById("chat-search").addEventListener("input", () => renderHistory());

function renderMessages() {
  const chat = activeChat();
  if (!chat || chat.messages.length === 0) {
    els.messages.innerHTML = `
      <div class="welcome">
        <svg class="logo-mark" style="width:36px;height:36px" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l3 7 7 3-7 3-3 7-3-7-7-3 7-3z"/></svg>
        <h1>What are we building today?</h1>
        <p>Free AI agents for code, bugs and hard problems.</p>
        <div class="suggestions">
          <button type="button">Write a Python script that renames all files in a folder</button>
          <button type="button">Explain JavaScript promises like I'm a beginner</button>
          <button type="button">Find the bug: for (let i = 0; i <= arr.length; i++)</button>
          <button type="button">Plan a weekend project to learn React</button>
        </div>
      </div>`;
    els.messages.querySelectorAll(".suggestions button").forEach((b) => {
      b.onclick = () => sendMessage(b.textContent);
    });
    return;
  }
  const thread = document.createElement("div");
  thread.className = "thread";
  chat.messages.forEach((message, index) => {
    const isLast = index === chat.messages.length - 1;
    thread.appendChild(messageElement(message, index, isLast));
  });
  els.messages.replaceChildren(thread);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function actionButton(label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "msg-action";
  button.textContent = label;
  button.onclick = onClick;
  return button;
}

function messageElement(message, index, isLast) {
  const div = document.createElement("div");
  const actions = document.createElement("div");
  actions.className = "msg-actions";
  if (message.role === "user") {
    div.className = "msg msg-user";
    if (message.files?.length) {
      const chips = document.createElement("div");
      chips.className = "chips";
      for (const name of message.files) {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = `Attached: ${name}`;
        chips.appendChild(chip);
      }
      div.appendChild(chips);
    }
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = message.display ?? message.content; // display = what the user typed, without file contents
    div.appendChild(bubble);
    if (index !== undefined) actions.appendChild(actionButton("Edit", () => editMessage(index)));
  } else {
    div.className = "msg msg-ai";
    fillAssistant(div, message.content);
    if (isLast && !isStreaming) {
      actions.append(
        actionButton("Copy", () => copyText(message.content.replace(/^\[\[tool\]\] .*\n?/gm, "").split("[[error]]")[0].trim())),
        actionButton("Regenerate", regenerate),
      );
    }
  }
  if (actions.children.length) div.appendChild(actions);
  return div;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied.");
  } catch {
    toast("Couldn't copy — your browser blocked it.");
  }
}

// Every code block gets a Copy button (one click handler for all of them).
els.messages.addEventListener("click", (e) => {
  const button = e.target.closest(".copy-code");
  if (button) copyText(button.parentElement.querySelector("code").textContent);
});

function fillAssistant(div, content) {
  const [answer, error] = content.split("[[error]]");
  // Lines starting with [[tool]] are status updates from connectors ("Reading example.com").
  const statuses = answer.match(/^\[\[tool\]\] .*$/gm) || [];
  const text = answer.replace(/^\[\[tool\]\] .*\n?/gm, "").replace(/【[^】]*】/g, ""); // also drop web-search citation codes
  div.innerHTML =
    statuses.map((s) => `<p class="tool-status">${escapeHtml(s.slice(9))}</p>`).join("") + renderMarkdown(text);
  if (error) div.innerHTML += `<div class="msg-error" role="alert">Something failed: ${escapeHtml(error.trim())}</div>`;
  div.querySelectorAll("pre").forEach((pre) => {
    highlight(pre.querySelector("code"));
    pre.insertAdjacentHTML("afterbegin", `<button type="button" class="copy-code" aria-label="Copy code">Copy</button>`);
  });
}

// Syntax colors from highlight.js (loaded in app.html). If it didn't load, code stays plain.
function highlight(code) {
  if (!window.hljs) return;
  const lang = code.className.match(/language-(\S+)/)?.[1];
  if (lang && !hljs.getLanguage(lang)) code.className = ""; // unknown language → let it guess
  hljs.highlightElement(code);
}

// ---------- Actions ----------

function openChat(id) {
  activeId = id;
  closeNav();
  renderHistory();
  renderMessages();
  els.input.focus();
}

function newChat() {
  activeId = null;
  closeNav();
  renderHistory();
  renderMessages();
  els.input.focus();
}

function deleteChat(id) {
  if (!confirm("Delete this chat?")) return;
  chats = chats.filter((c) => c.id !== id);
  if (activeId === id) activeId = null;
  if (cloudUser) window.tinkerCloud.deleteChat(id).catch(() => toast("Couldn't delete the chat from your account. Try again later."));
  syncedVersions.delete(id);
  saveChats();
  renderHistory();
  renderMessages();
}

async function sendMessage(text) {
  text = text.trim();
  if ((!text && attachments.length === 0) || isStreaming || limitedUntil > Date.now()) return;
  if (!text) text = "Please look at the attached file(s).";

  let chat = activeChat();
  if (!chat) {
    chat = { id: crypto.randomUUID(), title: text.slice(0, 60), messages: [] };
    chats.unshift(chat);
    activeId = chat.id;
  }
  // Attached files are added to the message text so the AI can read them.
  const fileText = attachments.map((f) => `\n\nFile: ${f.name}\n\`\`\`\n${f.text}\n\`\`\``).join("");
  chat.messages.push({ role: "user", content: text + fileText, display: text, files: attachments.map((f) => f.name) });
  attachments = [];
  renderAttachments();
  els.input.value = "";
  autoGrow();
  await requestReply(chat);
}

let controller = null; // lets the Stop button cancel the reply

async function requestReply(chat) {
  const reply = { role: "assistant", content: "" };
  chat.messages.push(reply);
  saveChats();
  renderHistory();
  renderMessages();
  setStreaming(true);

  const replyEl = els.messages.querySelector(".thread").lastElementChild;
  replyEl.classList.add("cursor");
  controller = new AbortController();

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify({ model: els.model.value, messages: chat.messages.slice(0, -1), ...requestExtras() }),
    });
    if (!response.ok) {
      reply.content = `[[error]] ${await response.text()}`;
      throw null;
    }

    // Streaming: read the reply piece by piece and show it as it arrives.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      reply.content += decoder.decode(value, { stream: true });
      fillAssistant(replyEl, reply.content);
      els.messages.scrollTop = els.messages.scrollHeight;
    }
    if (!reply.content.trim()) reply.content = "[[error]] The model returned an empty reply. Try again or switch models.";
  } catch (error) {
    if (error?.name === "AbortError") reply.content += "\n\n*(stopped)*";
    else if (error) reply.content += `\n\n[[error]] Couldn't reach the Tinker server (${error.message}). Check your internet and try again.`;
  }

  controller = null;
  saveChats();
  setStreaming(false);
  const limitWait = reply.content.match(/Ready again in (\d+)s/);
  if (limitWait) startCountdown(Number(limitWait[1]));
  renderMessages(); // redraw so the Regenerate / Edit buttons appear
  if (chat.messages.length === 2 && !reply.content.includes("[[error]]")) autoTitle(chat);
}

// After the first answer, ask the server for a short title based on what the chat is about.
// Never overwrites a name the user chose. If it fails, the chat keeps its first-message title.
async function autoTitle(chat) {
  if (chat.renamed) return;
  try {
    const response = await fetch("/api/title", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify({
        question: chat.messages[0].display ?? chat.messages[0].content,
        answer: chat.messages[1].content.replace(/^\[\[tool\]\] .*\n?/gm, ""),
      }),
    });
    if (!response.ok) return;
    const { title } = await response.json();
    if (title && !chat.renamed) {
      chat.title = title;
      saveChats();
      renderHistory();
    }
  } catch {
    // keep the current title
  }
}

// Free-limit countdown: shows when you can send again, and blocks sending until then.
let countdownTimer = null;
let limitedUntil = 0;

function startCountdown(seconds) {
  const notice = document.getElementById("limit-notice");
  limitedUntil = Date.now() + seconds * 1000;
  clearInterval(countdownTimer);
  const tick = () => {
    const left = Math.ceil((limitedUntil - Date.now()) / 1000);
    if (left <= 0) {
      clearInterval(countdownTimer);
      limitedUntil = 0;
      notice.textContent = "Ready. You can send again.";
      els.send.disabled = false;
      setTimeout(() => {
        if (!limitedUntil) notice.hidden = true; // unless a new countdown started meanwhile
      }, 3000);
      return;
    }
    notice.hidden = false;
    notice.textContent = `Free limit reached. Ready again in ${left}s. Add your own free Groq key in Customize to skip the wait.`;
    els.send.disabled = true;
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

function regenerate() {
  const chat = activeChat();
  if (!chat || isStreaming || limitedUntil > Date.now() || chat.messages.at(-1)?.role !== "assistant") return;
  chat.messages.pop();
  requestReply(chat);
}

// Edit: put the message back in the box and remove it (and everything after it) from the chat.
function editMessage(index) {
  const chat = activeChat();
  if (!chat || isStreaming) return;
  const message = chat.messages[index];
  if (chat.messages.length - index > 1 && !confirm("Editing removes this message and everything after it. Continue?")) return;
  chat.messages.splice(index);
  saveChats();
  renderMessages();
  els.input.value = message.display ?? message.content;
  autoGrow();
  els.input.focus();
}

const SEND_ICON = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`;
const STOP_ICON = `<svg class="icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;

function setStreaming(value) {
  isStreaming = value;
  els.send.innerHTML = value ? STOP_ICON : SEND_ICON;
  els.send.setAttribute("aria-label", value ? "Stop the answer" : "Send message");
}

async function loadModels() {
  try {
    const { models, skills = [], connectors = [], default: fallback } = await (await fetch("/api/models")).json();
    presetSkills = skills;
    connectorList = connectors;
    renderPanel();
    renderActive();
    const saved = localStorage.getItem("tinker.model");
    els.model.innerHTML = models
      .map((m) => `<option value="${m.id}">${m.label} · ${m.provider}${m.ready ? "" : " (no key)"}</option>`)
      .join("");
    els.model.value = models.some((m) => m.id === saved) ? saved : fallback;
  } catch {
    els.model.innerHTML = `<option>Server offline</option>`;
  }
}

// ---------- Skills, connectors and plugins ----------
// Saved in this browser. Sent with every message so the server knows what to use.

const SETTINGS_KEY = "tinker.settings";
const PLUGINS = [
  { id: "researcher", name: "Researcher", description: "Searches the web and reads pages", skill: null, connectors: ["search", "web"] },
  { id: "repo-explorer", name: "Repo Explorer", description: "Reads GitHub repos and reviews the code", skill: "reviewer", connectors: ["github", "web"] },
  { id: "bug-hunter", name: "Bug Hunter", description: "Debugs errors and looks up docs online", skill: "debugger", connectors: ["web", "search"] },
  { id: "teacher", name: "Teacher", description: "Explains things simply, with web lookups", skill: "explain", connectors: ["web"] },
];

let presetSkills = [];
let connectorList = [];
let settings = loadSettings();

function loadSettings() {
  const empty = { skillId: null, customSkills: [], connectors: [], mcp: [], plugins: [] };
  try {
    return { ...empty, ...JSON.parse(localStorage.getItem(SETTINGS_KEY)) };
  } catch {
    return empty;
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // storage blocked — settings last until the page closes
  }
  renderPanel();
  renderActive();
}

const allSkills = () => [...presetSkills, ...settings.customSkills];
const activeSkill = () => allSkills().find((s) => s.id === settings.skillId);

function requestExtras() {
  const skill = activeSkill();
  return {
    skill: skill ? (skill.custom ? { name: skill.name, instructions: skill.instructions } : { id: skill.id }) : null,
    connectors: settings.connectors,
    mcp: settings.mcp.filter((s) => s.enabled),
  };
}

function optionRow({ type, name, checked, title, description, onChange, onRemove }) {
  const label = document.createElement("label");
  label.className = "option";
  label.innerHTML = `<input type="${type}" ${name ? `name="${name}"` : ""} ${checked ? "checked" : ""} />
    <span class="text"><strong></strong><span class="desc"></span></span>`;
  label.querySelector("strong").textContent = title;
  label.querySelector(".desc").textContent = description;
  label.querySelector("input").onchange = (e) => onChange(e.target.checked);
  if (onRemove) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove";
    remove.textContent = "✕";
    remove.setAttribute("aria-label", `Remove ${title}`);
    remove.onclick = (e) => {
      e.preventDefault();
      if (confirm(`Remove "${title}"?`)) onRemove();
    };
    label.appendChild(remove);
  }
  return label;
}

function togglePlugin(plugin, on) {
  settings.plugins = settings.plugins.filter((id) => id !== plugin.id);
  if (on) {
    settings.plugins.push(plugin.id);
    settings.connectors = [...new Set([...settings.connectors, ...plugin.connectors])];
    if (plugin.skill) settings.skillId = plugin.skill;
  } else {
    // keep connectors another active plugin still needs
    const stillNeeded = PLUGINS.filter((p) => settings.plugins.includes(p.id)).flatMap((p) => p.connectors);
    settings.connectors = settings.connectors.filter((c) => !plugin.connectors.includes(c) || stillNeeded.includes(c));
    if (plugin.skill && settings.skillId === plugin.skill) settings.skillId = null;
  }
  saveSettings();
}

function renderPanel() {
  const pluginList = document.getElementById("plugin-list");
  pluginList.replaceChildren(...PLUGINS.map((plugin) => optionRow({
    type: "checkbox",
    checked: settings.plugins.includes(plugin.id),
    title: plugin.name,
    description: plugin.description,
    onChange: (on) => togglePlugin(plugin, on),
  })));

  const skillList = document.getElementById("skill-list");
  skillList.replaceChildren(
    optionRow({ type: "radio", name: "skill", checked: !settings.skillId, title: "No skill", description: "Tinker's normal behavior", onChange: () => { settings.skillId = null; saveSettings(); } }),
    ...allSkills().map((skill) => optionRow({
      type: "radio",
      name: "skill",
      checked: settings.skillId === skill.id,
      title: skill.name,
      description: skill.custom ? "Your skill" : skill.description,
      onChange: () => { settings.skillId = skill.id; saveSettings(); },
      onRemove: skill.custom ? () => {
        settings.customSkills = settings.customSkills.filter((s) => s.id !== skill.id);
        if (settings.skillId === skill.id) settings.skillId = null;
        saveSettings();
      } : null,
    })),
  );

  document.getElementById("connector-list").replaceChildren(...connectorList.map((connector) => optionRow({
    type: "checkbox",
    checked: settings.connectors.includes(connector.id),
    title: connector.label,
    description: connector.description,
    onChange: (on) => {
      settings.connectors = on ? [...settings.connectors, connector.id] : settings.connectors.filter((c) => c !== connector.id);
      saveSettings();
    },
  })));

  const mcpList = document.getElementById("mcp-list");
  if (settings.mcp.length === 0) {
    mcpList.innerHTML = `<p class="muted small">No MCP servers yet.</p>`;
  } else {
    mcpList.replaceChildren(...settings.mcp.map((server, index) => optionRow({
      type: "checkbox",
      checked: server.enabled,
      title: server.name,
      description: server.url,
      onChange: (on) => { settings.mcp[index].enabled = on; saveSettings(); },
      onRemove: () => { settings.mcp.splice(index, 1); saveSettings(); },
    })));
  }
}

// Optional personal Groq key: saved only in this browser, sent with each request as a header.
const keyHeader = () => (settings.groqKey ? { "X-Groq-Key": settings.groqKey } : {});

function renderKey() {
  const status = document.getElementById("key-status");
  const input = document.getElementById("groq-key");
  if (settings.groqKey) {
    input.value = "";
    input.placeholder = `Saved: ${settings.groqKey.slice(0, 8)}…`;
    status.textContent = "Using your key. It's stored only in this browser and passes through the Tinker server to Groq.";
    document.getElementById("key-save").textContent = "Replace";
  } else {
    input.placeholder = "gsk_…";
    status.textContent = "Using the shared key.";
    document.getElementById("key-save").textContent = "Save";
  }
  status.toggleAttribute("data-has-key", Boolean(settings.groqKey));
  if (settings.groqKey && !document.getElementById("key-remove")) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.id = "key-remove";
    remove.className = "msg-action";
    remove.textContent = "Remove my key";
    remove.onclick = () => { delete settings.groqKey; saveSettings(); };
    status.after(remove);
  } else if (!settings.groqKey) {
    document.getElementById("key-remove")?.remove();
  }
}

document.getElementById("key-form").onsubmit = (e) => {
  e.preventDefault();
  const key = document.getElementById("groq-key").value.trim();
  if (!/^gsk_[A-Za-z0-9]{20,}$/.test(key)) {
    toast("That doesn't look like a Groq key. It should start with gsk_.");
    return;
  }
  settings.groqKey = key;
  saveSettings();
  toast("Saved. Your messages now use your own Groq limits.");
};

function renderActive() {
  renderKey();
  const parts = [];
  const skill = activeSkill();
  if (skill) parts.push(`Skill: ${skill.name}`);
  const names = connectorList.filter((c) => settings.connectors.includes(c.id)).map((c) => c.label);
  names.push(...settings.mcp.filter((s) => s.enabled).map((s) => s.name));
  if (names.length) parts.push(`Connectors: ${names.join(", ")}`);
  document.getElementById("active-tools").textContent = parts.join(" · ");
}

const panel = document.getElementById("panel");
document.getElementById("customize").onclick = () => panel.showModal();
document.getElementById("panel-close").onclick = () => panel.close();
panel.addEventListener("click", (e) => e.target === panel && panel.close()); // click outside closes

document.getElementById("skill-form").onsubmit = (e) => {
  e.preventDefault();
  const skill = {
    id: `custom-${Date.now()}`,
    custom: true,
    name: document.getElementById("skill-name").value.trim(),
    instructions: document.getElementById("skill-instructions").value.trim(),
  };
  settings.customSkills.push(skill);
  settings.skillId = skill.id;
  e.target.reset();
  saveSettings();
};

document.getElementById("mcp-form").onsubmit = (e) => {
  e.preventDefault();
  settings.mcp.push({
    name: document.getElementById("mcp-name").value.trim(),
    url: document.getElementById("mcp-url").value.trim(),
    token: document.getElementById("mcp-token").value.trim(),
    enabled: true,
  });
  e.target.reset();
  saveSettings();
};

// ---------- Small notice at the bottom of the screen ----------

function toast(message) {
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "status");
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ---------- Attach files ----------

const MAX_FILE_SIZE = 30_000; // ~30 KB of text per file (the free Groq tier limits how much text fits)
let attachments = []; // [{ name, text }]

function renderAttachments() {
  const box = document.getElementById("attachments");
  box.replaceChildren(...attachments.map((file, index) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.innerHTML = `<span></span><button type="button">✕</button>`;
    chip.querySelector("span").textContent = file.name;
    chip.querySelector("button").setAttribute("aria-label", `Remove ${file.name}`);
    chip.querySelector("button").onclick = () => {
      attachments.splice(index, 1);
      renderAttachments();
    };
    return chip;
  }));
}

document.getElementById("attach").onclick = () => document.getElementById("file-input").click();
document.getElementById("file-input").onchange = async (e) => {
  for (const file of e.target.files) {
    if (file.size > MAX_FILE_SIZE) {
      toast(`${file.name} is too big (max 30 KB on the free plan).`);
      continue;
    }
    const text = await file.text();
    if (text.includes("\u0000")) {
      toast(`${file.name} isn't a text file. Only text and code files can be attached.`);
      continue;
    }
    attachments.push({ name: file.name, text });
  }
  e.target.value = "";
  renderAttachments();
  els.input.focus();
};

// ---------- Voice input ----------
// Records from the microphone, then the server turns the audio into text with Groq Whisper.

const micButton = document.getElementById("mic");
let recorder = null;

micButton.onclick = async () => {
  if (recorder) {
    recorder.stop();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    toast("Voice input isn't supported in this browser.");
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    toast("Microphone access was blocked. Allow it in your browser settings to use voice input.");
    return;
  }
  const chunks = [];
  recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (e) => chunks.push(e.data);
  recorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    recorder = null;
    micButton.setAttribute("aria-pressed", "false");
    micButton.setAttribute("aria-label", "Start voice input");
    micButton.disabled = true;
    toast("Turning your voice into text…");
    try {
      const audio = new Blob(chunks, { type: chunks[0]?.type || "audio/webm" });
      const response = await fetch("/api/transcribe", { method: "POST", headers: { "Content-Type": audio.type, ...(await authHeaders()) }, body: audio });
      if (!response.ok) throw new Error(await response.text());
      const { text } = await response.json();
      els.input.value = (els.input.value ? els.input.value + " " : "") + text.trim();
      autoGrow();
      els.input.focus();
    } catch (error) {
      toast(`Couldn't understand the recording: ${error.message}`);
    }
    micButton.disabled = false;
  };
  recorder.start();
  micButton.setAttribute("aria-pressed", "true");
  micButton.setAttribute("aria-label", "Stop recording");
  toast("Listening… click the mic again to stop.");
};

// ---------- Export and share ----------

function chatToMarkdown(chat) {
  const body = chat.messages
    .map((m) => `## ${m.role === "user" ? "You" : "Tinker"}\n\n${m.content.replace(/^\[\[tool\]\] .*\n?/gm, "")}`)
    .join("\n\n");
  return `# ${chat.title}\n\n${body}\n`;
}

document.getElementById("export").onclick = () => {
  const chat = activeChat();
  if (!chat) return toast("Start a chat first, then you can download it.");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([chatToMarkdown(chat)], { type: "text/markdown" }));
  link.download = `${chat.title.replace(/[^\w -]/g, "").trim().slice(0, 40) || "tinker-chat"}.md`;
  link.click();
  URL.revokeObjectURL(link.href);
};

// Share links hold the whole chat inside the link (compressed), so no database is needed.
// ponytail: very long chats make very long links; store shares on the server once there's a database.
async function compress(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function decompress(code) {
  const bytes = Uint8Array.from(atob(code.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

document.getElementById("share").onclick = async () => {
  const chat = activeChat();
  if (!chat) return toast("Start a chat first, then you can share it.");
  const data = { title: chat.title, messages: chat.messages.map(({ role, content, display, files }) => ({ role, content, display, files })) };
  const url = `${location.origin}/app#share=${await compress(JSON.stringify(data))}`;
  try {
    await navigator.clipboard.writeText(url);
    toast("Share link copied. Anyone with the link can see this chat.");
  } catch {
    prompt("Copy this share link:", url);
  }
};

async function openSharedChat() {
  const code = location.hash.match(/^#share=(.+)$/)?.[1];
  if (!code) return;
  history.replaceState(null, "", "/app"); // clean the address bar
  try {
    const shared = JSON.parse(await decompress(code));
    const messages = (shared.messages || []).filter((m) => typeof m.content === "string" && (m.role === "user" || m.role === "assistant"));
    const chat = { id: crypto.randomUUID(), title: `Shared: ${String(shared.title || "chat").slice(0, 50)}`, messages };
    chats.unshift(chat);
    saveChats();
    openChat(chat.id);
    toast("Shared chat added to your history.");
  } catch {
    toast("That share link is broken or incomplete.");
  }
}

// ---------- Mobile sidebar ----------

function closeNav() {
  els.app.classList.remove("nav-open");
  els.menu.setAttribute("aria-expanded", "false");
}
els.menu.onclick = () => {
  els.app.classList.add("nav-open");
  els.menu.setAttribute("aria-expanded", "true");
};
els.scrim.onclick = closeNav;
document.addEventListener("keydown", (e) => e.key === "Escape" && closeNav());

// ---------- Composer ----------

function autoGrow() {
  els.input.style.height = "auto";
  els.input.style.height = els.input.scrollHeight + "px";
}
els.input.addEventListener("input", autoGrow);
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage(els.input.value);
  }
});
els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (isStreaming) controller?.abort(); // the send button is a Stop button while answering
  else sendMessage(els.input.value);
});
els.model.addEventListener("change", () => localStorage.setItem("tinker.model", els.model.value));
document.getElementById("new-chat").onclick = newChat;


loadModels();
renderActive();
renderHistory();
renderMessages();
openSharedChat();

// Installable app: register the service worker (it lets Tinker open as an app, even offline).
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

// "Install app" button: only shown when the browser says Tinker can be installed.
let installPrompt = null;
addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  document.getElementById("install").hidden = false;
});
document.getElementById("install").onclick = async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  document.getElementById("install").hidden = true;
};
addEventListener("appinstalled", () => (document.getElementById("install").hidden = true));
