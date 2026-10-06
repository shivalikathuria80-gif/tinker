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
      const lang = parts[i + 1] ? ` data-lang="${escapeHtml(parts[i + 1])}"` : "";
      html += `<pre${lang}><code>${escapeHtml(parts[i + 2].replace(/\n$/, ""))}</code></pre>`;
    }
  }
  if (thinking) {
    html = `<details><summary>Thinking</summary>${renderProse(thinking)}</details>` + html;
  }
  return html;
}

function renderProse(text) {
  return text
    .trim()
    .split(/\n{2,}/)
    .filter(Boolean)
    .map((block) => {
      let safe = escapeHtml(block)
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      const heading = safe.match(/^#{1,4}\s+(.*)/);
      if (heading) return `<p><strong>${heading[1]}</strong></p>`;
      if (/^(\s*[-*]|\s*\d+\.)\s/.test(safe)) {
        const items = safe.split("\n").map((line) => `<li>${line.replace(/^\s*([-*]|\d+\.)\s/, "")}</li>`);
        return /^\s*\d+\./.test(safe) ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`;
      }
      return `<p>${safe.replace(/\n/g, "<br>")}</p>`;
    })
    .join("");
}

function renderHistory() {
  if (chats.length === 0) {
    els.list.innerHTML = `<p class="history-empty">No chats yet. Start one!</p>`;
    return;
  }
  els.list.innerHTML = "";
  for (const chat of chats) {
    const row = document.createElement("div");
    row.className = "chat-item" + (chat.id === activeId ? " active" : "");
    row.innerHTML = `
      <button class="open" type="button" ${chat.id === activeId ? 'aria-current="true"' : ""}></button>
      <button class="del" type="button" aria-label="Delete chat">✕</button>`;
    row.querySelector(".open").textContent = chat.title;
    row.querySelector(".open").title = chat.title;
    row.querySelector(".open").onclick = () => openChat(chat.id);
    row.querySelector(".del").onclick = () => deleteChat(chat.id);
    els.list.appendChild(row);
  }
}

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
  for (const message of chat.messages) thread.appendChild(messageElement(message));
  els.messages.replaceChildren(thread);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function messageElement(message) {
  const div = document.createElement("div");
  if (message.role === "user") {
    div.className = "msg msg-user";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = message.content;
    div.appendChild(bubble);
  } else {
    div.className = "msg msg-ai";
    fillAssistant(div, message.content);
  }
  return div;
}

function fillAssistant(div, content) {
  const [answer, error] = content.split("[[error]]");
  div.innerHTML = renderMarkdown(answer);
  if (error) div.innerHTML += `<div class="msg-error" role="alert">Something failed: ${escapeHtml(error.trim())}</div>`;
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
  saveChats();
  renderHistory();
  renderMessages();
}

async function sendMessage(text) {
  text = text.trim();
  if (!text || isStreaming) return;

  let chat = activeChat();
  if (!chat) {
    chat = { id: crypto.randomUUID(), title: text.slice(0, 60), messages: [] };
    chats.unshift(chat);
    activeId = chat.id;
  }
  chat.messages.push({ role: "user", content: text });
  const reply = { role: "assistant", content: "" };
  chat.messages.push(reply);
  saveChats();
  renderHistory();
  renderMessages();

  els.input.value = "";
  autoGrow();
  setStreaming(true);

  const replyEl = els.messages.querySelector(".thread").lastElementChild;
  replyEl.classList.add("cursor");

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: els.model.value, messages: chat.messages.slice(0, -1) }),
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
    if (error) reply.content += `\n\n[[error]] Couldn't reach the Tinker server (${error.message}). Check your internet and try again.`;
  }

  fillAssistant(replyEl, reply.content);
  replyEl.classList.remove("cursor");
  saveChats();
  setStreaming(false);
}

function setStreaming(value) {
  isStreaming = value;
  els.send.disabled = value;
  els.send.setAttribute("aria-label", value ? "Waiting for reply" : "Send message");
}

async function loadModels() {
  try {
    const { models, default: fallback } = await (await fetch("/api/models")).json();
    const saved = localStorage.getItem("tinker.model");
    els.model.innerHTML = models
      .map((m) => `<option value="${m.id}">${m.label} · ${m.provider}${m.ready ? "" : " (no key)"}</option>`)
      .join("");
    els.model.value = models.some((m) => m.id === saved) ? saved : fallback;
  } catch {
    els.model.innerHTML = `<option>Server offline</option>`;
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
  sendMessage(els.input.value);
});
els.model.addEventListener("change", () => localStorage.setItem("tinker.model", els.model.value));
document.getElementById("new-chat").onclick = newChat;
document.getElementById("sign-in").onclick = () => alert("Sign in is coming soon. Your chats are saved in this browser for now.");

loadModels();
renderHistory();
renderMessages();
