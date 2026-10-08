// Settings page: account, theme, default model, voice, export and deletion.
// Uses Firebase through window.tinkerCloud (firebase.js) and the same browser storage as the app.

const cloud = window.tinkerCloud;
const $ = (id) => document.getElementById(id);
lucide.createIcons();

const store = {
  get: (key) => { try { return localStorage.getItem(key); } catch { return null; } },
  set: (key, value) => { try { localStorage.setItem(key, value); } catch {} },
  remove: (key) => { try { localStorage.removeItem(key); } catch {} },
};
const localChats = () => { try { return JSON.parse(store.get("tinker.chats")) || []; } catch { return []; } };

function status(message) {
  $("status").textContent = message;
  clearTimeout(status.timer);
  status.timer = setTimeout(() => ($("status").textContent = ""), 5000);
}

// ---------- Appearance ----------
const savedTheme = store.get("tinker.theme") || "system";
document.querySelector(`input[name="theme"][value="${savedTheme}"]`).checked = true;
document.querySelectorAll('input[name="theme"]').forEach((radio) => {
  radio.onchange = () => {
    store.set("tinker.theme", radio.value);
    if (radio.value === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = radio.value;
  };
});

// ---------- Default model ----------
fetch("/api/models")
  .then((r) => r.json())
  .then(({ models, default: fallback }) => {
    const select = $("default-model");
    select.innerHTML = models.map((m) => `<option value="${m.id}">${m.label} · by ${m.note}</option>`).join("");
    const saved = store.get("tinker.model");
    select.value = models.some((m) => m.id === saved) ? saved : fallback;
    select.onchange = () => {
      store.set("tinker.model", select.value);
      status("Default model saved.");
    };
  })
  .catch(() => ($("default-model").innerHTML = "<option>Couldn't load models</option>"));

// ---------- Voice ----------
let previewAudio = null;
function renderVoices(voices) {
  const saved = store.get("tinker.voice") || "";
  const options = [
    ...voices.map((v) => ({ id: v.id, name: v.name + (v.default ? " (default)" : ""), description: v.description || "ElevenLabs voice", preview: v.preview, checked: saved ? saved === v.id : v.default })),
    { id: "browser", name: "Browser voice", description: "Your device's built-in voice. Free and offline, less natural.", checked: saved === "browser" || (!voices.length && !saved) },
  ];
  $("voice-list").innerHTML = "";
  for (const option of options) {
    const row = document.createElement("label");
    row.className = "voice-option";
    row.innerHTML = `<input type="radio" name="voice" /><span class="text"><strong></strong><span class="desc"></span></span>`;
    row.querySelector("input").value = option.id;
    row.querySelector("input").checked = option.checked;
    row.querySelector("strong").textContent = option.name;
    row.querySelector(".desc").textContent = option.description;
    row.querySelector("input").onchange = () => {
      store.set("tinker.voice", option.id);
      status(`Voice mode will use ${option.name.replace(" (default)", "")}.`);
    };
    if (option.preview) {
      const play = document.createElement("button");
      play.type = "button";
      play.className = "play";
      play.setAttribute("aria-label", `Play a sample of ${option.name}`);
      play.innerHTML = `<i data-lucide="play"></i>`;
      play.onclick = (e) => {
        e.preventDefault();
        previewAudio?.pause();
        previewAudio = new Audio(option.preview);
        previewAudio.play().catch(() => status("Couldn't play the sample."));
      };
      row.appendChild(play);
    }
    $("voice-list").appendChild(row);
  }
  lucide.createIcons();
}
fetch("/api/voices")
  .then((r) => (r.ok ? r.json() : { voices: [] }))
  .then(({ voices }) => renderVoices(voices))
  .catch(() => renderVoices([]));

// ---------- Your data ----------
function renderDataSummary() {
  const count = localChats().length;
  $("data-summary").textContent = cloud?.currentUser()
    ? `${count} chat${count === 1 ? "" : "s"} on this device, synced to your account.`
    : `${count} chat${count === 1 ? "" : "s"} saved in this browser.`;
}

$("export").onclick = async () => {
  const byId = new Map(localChats().map((c) => [c.id, c]));
  if (cloud?.currentUser()) {
    try {
      for (const chat of await cloud.listChats()) if (!byId.has(chat.id) || (chat.updated || 0) > (byId.get(chat.id).updated || 0)) byId.set(chat.id, chat);
    } catch {
      status("Couldn't load chats from your account, so only this device's chats were exported.");
    }
  }
  const chats = [...byId.values()];
  const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), chats }, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `tinker-chats-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  status(`Exported ${chats.length} chat${chats.length === 1 ? "" : "s"}.`);
};

$("clear-local").onclick = () => {
  const signedIn = Boolean(cloud?.currentUser());
  const warning = signedIn
    ? "Delete the chats on this device? Chats saved to your account stay there and come back next time you open Tinker."
    : "Delete all chats saved in this browser? This can't be undone.";
  if (!confirm(warning)) return;
  store.remove("tinker.chats");
  renderDataSummary();
  status("Chats on this device deleted.");
};

// ---------- Account ----------
cloud.onUserChange((user) => {
  $("signed-out-box").hidden = Boolean(user);
  $("signed-in-box").hidden = !user;
  $("danger-zone").hidden = !user;
  if (user) {
    $("display-name").value = user.displayName || "";
    $("account-email").textContent = `Signed in as ${user.email}`;
    $("password-confirm").hidden = !cloud.usesPassword();
  }
  renderDataSummary();
});

$("name-form").onsubmit = async (e) => {
  e.preventDefault();
  const name = $("display-name").value.trim();
  if (!name) return status("Please enter a name.");
  try {
    await cloud.updateName(name);
    status("Name saved.");
  } catch {
    status("Couldn't save your name. Try again.");
  }
};

$("sign-out").onclick = async () => {
  await cloud.signOut();
  store.remove("tinker.chats"); // same as the app: account chats leave this device on sign-out
  status("Signed out.");
};

$("delete-form").onsubmit = async (e) => {
  e.preventDefault();
  if ($("delete-confirm").value.trim() !== "DELETE") {
    status('Type DELETE (in capitals) to confirm.');
    $("delete-confirm").focus();
    return;
  }
  const button = $("delete-account");
  button.disabled = true;
  try {
    try {
      await cloud.deleteAccount();
    } catch (error) {
      // Firebase wants a recent sign-in before deleting an account.
      if (error?.code !== "auth/requires-recent-login") throw error;
      if (cloud.usesPassword() && !$("delete-password").value) {
        status("For safety, enter your password, then press Delete again.");
        $("delete-password").focus();
        button.disabled = false;
        return;
      }
      await cloud.confirmIdentity($("delete-password").value);
      await cloud.deleteAccount();
    }
    store.remove("tinker.chats");
    alert("Your account and all its chats have been deleted.");
    location.assign("/");
  } catch (error) {
    const wrongPassword = ["auth/invalid-credential", "auth/wrong-password"].includes(error?.code);
    status(wrongPassword ? "That password isn't right." : `Couldn't delete the account (${error?.code || error?.message}).`);
    button.disabled = false;
  }
};

renderDataSummary();
