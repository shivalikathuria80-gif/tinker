// Landing page motion. Every animation shows a real Tinker feature.
// Rules: only animate while on screen, use transform/opacity, and respect "reduce motion".

const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

// ---------- Small helpers ----------

document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Press Ctrl+C";
    }
    setTimeout(() => (button.textContent = "Copy"), 1500);
  });
});

const nav = document.getElementById("nav");
addEventListener("scroll", () => nav.classList.toggle("scrolled", scrollY > 8), { passive: true });

// Tracks whether an element is on screen, so loops can wait while it isn't.
function watchVisible(element) {
  const state = { visible: false };
  new IntersectionObserver(([entry]) => (state.visible = entry.isIntersecting)).observe(element);
  return state;
}

// Reveal sections as they scroll into view.
const revealer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) {
      entry.target.classList.add("in");
      revealer.unobserve(entry.target);
    }
  }
}, { threshold: 0.12 });
document.querySelectorAll(".reveal").forEach((el) => (calm ? el.classList.add("in") : revealer.observe(el)));

// ---------- Hero headline: write → run → fix → test ----------

const swap = document.getElementById("swap");
document.getElementById("hero-title").setAttribute("aria-label", "AI agents that write, run, fix and test your code with you.");
if (!calm) {
  // The word is always set by a timer; CSS only fades it. (Never wait on animation-end events:
  // browsers pause those in background tabs, which could leave the word invisible.)
  const words = ["write", "run", "fix", "test"];
  let index = 0;
  setInterval(() => {
    if (document.hidden) return;
    index = (index + 1) % words.length;
    swap.classList.add("out");
    setTimeout(() => {
      swap.textContent = words[index];
      swap.classList.remove("out");
    }, 180);
  }, 2400);
}

// ---------- Hero terminal demo ----------

const term = document.getElementById("term");
const toggle = document.getElementById("demo-toggle");
const heroSeen = watchVisible(document.getElementById("hero-demo"));
let paused = false;

// Each step is one line. type: true = typed out letter by letter (what the user types).
const SCRIPT = [
  { html: '<span class="muted">$</span> tinker', type: true, wait: 300 },
  { html: '<span class="muted">  Loaded project rules from TINKER.md</span>', wait: 250 },
  { html: '<span class="muted">  model: qwen/qwen3.8-27b · folder: ~/my-app</span>', wait: 500 },
  { html: "" },
  { html: '<span class="acc">›</span> the cart total is wrong when the cart is empty, fix it', type: true, wait: 400 },
  { html: '<span class="muted">  ● Listing files in .</span>', wait: 450 },
  { html: '<span class="muted">  ● Reading src/cart.js</span>', wait: 450 },
  { html: '<span class="muted">  ● Wants to write src/cart.js</span>', wait: 350 },
  { html: '<span class="acc">  ?</span> Change src/cart.js?', wait: 200 },
  { html: '<span class="muted">    export function total(items) {</span>', wait: 120 },
  { html: '<span class="del">  -   return items.reduce((s, i) => s + i.price)</span>', wait: 120 },
  { html: '<span class="add">  +   return items.reduce((s, i) => s + i.price, 0)</span>', wait: 120 },
  { html: '<span class="muted">    }</span>', wait: 120 },
  { html: '  <span class="add">+1</span> <span class="del">-1</span>  <span class="muted">(y/n)</span> y', wait: 600 },
  { html: '<span class="muted">  ● Wants to run: npm test</span>', wait: 250 },
  { html: '<span class="acc">  ?</span> Run this command? <span class="muted">(y/n)</span> y', wait: 700 },
  { html: '<span class="add">  ✓ 12 tests passed</span>', wait: 300 },
  { html: "" },
  { html: "Fixed: <code>reduce</code> had no starting value, so an empty cart crashed. It now starts at 0.", wait: 300 },
];

function addLine(html) {
  const line = document.createElement("span");
  line.className = "line";
  line.innerHTML = html || " ";
  term.appendChild(line);
  return line;
}

async function waitWhilePaused() {
  while (paused || !heroSeen.visible) await sleep(200);
}

async function typeLine(html) {
  // Type the text part letter by letter, keeping the colored prompt as-is.
  const promptMatch = html.match(/^(<span[^>]*>[^<]*<\/span>\s?)(.*)$/);
  const prompt = promptMatch ? promptMatch[1] : "";
  const text = promptMatch ? promptMatch[2] : html;
  const line = addLine(prompt);
  line.classList.add("caret");
  for (let i = 1; i <= text.length; i++) {
    await waitWhilePaused();
    line.innerHTML = prompt + escapeHtml(text.slice(0, i));
    await sleep(22 + Math.random() * 30);
  }
  line.classList.remove("caret");
}

async function runDemo() {
  if (calm) {
    SCRIPT.forEach((step) => addLine(step.html));
    toggle.hidden = true;
    return;
  }
  while (true) {
    term.textContent = "";
    for (const step of SCRIPT) {
      await waitWhilePaused();
      if (step.type) await typeLine(step.html);
      else addLine(step.html);
      await sleep(step.wait || 80);
    }
    const end = addLine("");
    end.classList.add("caret");
    await sleep(4000);
  }
}

toggle.addEventListener("click", () => {
  paused = !paused;
  toggle.textContent = paused ? "Play" : "Pause";
  toggle.setAttribute("aria-pressed", String(paused));
});
runDemo();

// ---------- Web app mock: question → web search → table answer → chat names itself ----------

const mockMain = document.getElementById("mock-main");
const mockTitle = document.getElementById("mock-title");
const webSeen = watchVisible(document.getElementById("web-demo"));

const ANSWER = `Both are solid. Quick comparison:
<table><tr><th></th><th>Vite</th><th>Webpack</th></tr>
<tr><td>Dev start</td><td>~0.3s</td><td>~4s</td></tr>
<tr><td>Config</td><td>Minimal</td><td>More</td></tr></table>`;

async function typeInto(element, text, speed = 35) {
  for (let i = 1; i <= text.length; i++) {
    element.textContent = text.slice(0, i);
    await sleep(speed);
  }
}

async function runWebDemo() {
  const show = (html, className) => {
    const el = document.createElement("div");
    el.className = className;
    el.innerHTML = html;
    if (!calm) el.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 300, easing: "ease-out" });
    mockMain.appendChild(el);
    return el;
  };
  if (calm) {
    show("Should I use Vite or Webpack?", "bubble");
    show("Web search is on", "status");
    show(ANSWER, "answer");
    mockTitle.textContent = "Vite vs Webpack";
    return;
  }
  while (true) {
    while (!webSeen.visible) await sleep(300);
    mockMain.textContent = "";
    mockTitle.textContent = "New chat";
    show("Should I use Vite or Webpack?", "bubble");
    await sleep(700);
    show("Web search is on", "status");
    await sleep(500);
    show("Searching the web…", "status");
    await sleep(1100);
    show(ANSWER, "answer");
    await sleep(900);
    await typeInto(mockTitle, "Vite vs Webpack");
    await sleep(4500);
  }
}
runWebDemo();

// ---------- Feature tiles ----------

const voice = document.getElementById("voice-demo");
if (!calm) new IntersectionObserver(([entry]) => voice.classList.toggle("playing", entry.isIntersecting)).observe(voice);

// Light up chips one after another (connectors, skills).
function cycleChips(id, interval) {
  const box = document.getElementById(id);
  const chips = [...box.children];
  if (calm) {
    chips.forEach((chip) => chip.classList.add("on"));
    return;
  }
  const seen = watchVisible(box);
  let index = 0;
  setInterval(() => {
    if (!seen.visible) return;
    chips.forEach((chip, i) => chip.classList.toggle("on", i <= index));
    index = (index + 1) % (chips.length + 1);
  }, interval);
}
cycleChips("chips-demo", 700);
cycleChips("skills-demo", 900);

// ---------- Live model list ----------

fetch("/api/models")
  .then((response) => response.json())
  .then(({ models, default: fallback }) => {
    if (!models?.length) return;
    document.getElementById("model-list").innerHTML = models
      .map((m) => {
        const extras = m.id.startsWith("openai/gpt-oss") ? " · web search · run code" : "";
        const maker = m.note ? `by ${escapeHtml(m.note)}` : "";
        const label = (m.id === fallback ? `Default · ${maker}` : maker) + extras;
        return `<div class="model${m.id === fallback ? " default" : ""}"><code>${escapeHtml(m.id)}</code><span>${label}</span></div>`;
      })
      .join("");
  })
  .catch(() => {
    // keep the built-in list
  });
