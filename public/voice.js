// Voice mode: a hands-free spoken conversation.
// Loop: listen → notice you stopped talking → turn speech into text (Groq Whisper, /api/transcribe)
//       → send it as a normal chat message → read the answer aloud (the browser's built-in voices) → listen again.
// Uses helpers from app.js: sendMessage, activeChat, authHeaders, toast, controller, limitedUntil.

const voiceEls = {
  dialog: document.getElementById("voice"),
  orb: document.getElementById("voice-orb"),
  orbAction: document.getElementById("orb-action"),
  status: document.getElementById("voice-status"),
  you: document.getElementById("voice-you"),
  reply: document.getElementById("voice-reply"),
  mute: document.getElementById("voice-mute"),
};

const voice = { active: false, muted: false, stream: null, audio: null, analyser: null, stopListening: null, speaking: false };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setVoiceState(state, text) {
  voiceEls.orb.dataset.state = state;
  voiceEls.status.textContent = text;
  voiceEls.orbAction.textContent = { listening: "Tap to stop listening and send", thinking: "Tap to cancel", speaking: "Tap to interrupt" }[state] || "";
  voiceEls.orb.style.setProperty("--level", 0);
}

// ---------- Listening: record until you pause ----------

function micLevel() {
  const data = new Uint8Array(voice.analyser.fftSize);
  voice.analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (const value of data) sum += ((value - 128) / 128) ** 2;
  return Math.sqrt(sum / data.length); // 0 = silence, ~0.3 = loud
}

// Resolves with the recording, or null if nobody spoke.
// ponytail: simple loudness-based pause detection; a proper voice-activity model would handle noisy rooms better.
function listenOnce() {
  return new Promise((resolve) => {
    const chunks = [];
    const recorder = new MediaRecorder(voice.stream);
    recorder.ondataavailable = (e) => chunks.push(e.data);

    let noiseFloor = 0.01;
    let started = 0;     // when speech began
    let lastLoud = 0;    // last moment it was loud
    let spoke = false;
    const begin = Date.now();

    const timer = setInterval(() => {
      const level = micLevel();
      const now = Date.now();
      voiceEls.orb.style.setProperty("--level", Math.min(1, level * 6).toFixed(2));
      if (now - begin < 400) noiseFloor = Math.max(noiseFloor, level); // learn the room's background noise
      const threshold = Math.max(0.02, noiseFloor * 2.5);
      if (level > threshold) {
        if (!started) started = now;
        if (now - started > 150) spoke = true; // ignore short clicks and bumps
        lastLoud = now;
      }
      const pausedAfterSpeech = spoke && now - lastLoud > 1300;
      const nobodySpoke = !spoke && now - begin > 15000;
      const tooLong = now - begin > 30000;
      if (pausedAfterSpeech || nobodySpoke || tooLong) finish();
    }, 50);

    function finish() {
      clearInterval(timer);
      voice.stopListening = null;
      if (recorder.state !== "inactive") recorder.stop();
    }
    voice.stopListening = () => {
      spoke = spoke || Boolean(started);
      finish();
    };
    recorder.onstop = () => resolve(spoke ? new Blob(chunks, { type: chunks[0]?.type || "audio/webm" }) : null);
    recorder.start();
  });
}

async function transcribe(audio) {
  const response = await fetch("/api/transcribe", { method: "POST", headers: { "Content-Type": audio.type, ...(await authHeaders()) }, body: audio });
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()).text.trim();
}

// ---------- Speaking: read the answer aloud ----------

// Turns a chat answer into something pleasant to hear.
function spokenText(content) {
  const [answer, error] = content.split("[[error]]");
  if (error) return `Sorry, something went wrong. ${error.replace(/\(Tip:.*\)/, "").trim()}`;
  return answer
    .replace(/^\[\[tool\]\] .*$/gm, "")
    .replace(/<think>[\s\S]*?(<\/think>|$)/g, "")
    .replace(/```[\s\S]*?(```|$)/g, " I've put the code in the chat. ")
    .replace(/【[^】]*】/g, "")
    .replace(/[*_#>`|]/g, "")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function pickVoice() {
  const voices = speechSynthesis.getVoices();
  const lang = navigator.language || "en-US";
  const sameLang = voices.filter((v) => v.lang.startsWith(lang.slice(0, 2)));
  return sameLang.find((v) => /natural|neural|google|premium|enhanced/i.test(v.name)) || sameLang[0] || voices[0] || null;
}

// Speaks sentence by sentence (long single utterances get cut off in some browsers).
async function speak(text) {
  if (!("speechSynthesis" in window) || !text) return;
  voice.speaking = true;
  const sentences = text.match(/[^.!?]+[.!?]*/g) || [text];
  const chosen = pickVoice();
  for (const sentence of sentences) {
    if (!voice.speaking || !voice.active) break;
    await new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance(sentence.trim());
      if (chosen) utterance.voice = chosen;
      utterance.rate = 1.05;
      utterance.onend = utterance.onerror = resolve;
      // Safety net: some browsers never report "finished", which would freeze voice mode.
      setTimeout(resolve, 2000 + sentence.split(" ").length * 600);
      speechSynthesis.speak(utterance);
    });
  }
  voice.speaking = false;
}

function stopSpeaking() {
  voice.speaking = false;
  speechSynthesis?.cancel();
}

// ---------- The conversation loop ----------

async function voiceLoop() {
  while (voice.active) {
    if (voice.muted) {
      setVoiceState("muted", "Mic muted. Unmute to keep talking.");
      while (voice.muted && voice.active) await pause(200);
      continue;
    }
    const waitSeconds = Math.ceil((limitedUntil - Date.now()) / 1000);
    if (waitSeconds > 0) {
      setVoiceState("idle", `Free limit reached. Ready again in ${waitSeconds}s.`);
      await pause(1000);
      continue;
    }

    setVoiceState("listening", "Listening…");
    const audio = await listenOnce();
    if (!voice.active) break;
    if (!audio) continue; // nobody spoke; keep listening

    setVoiceState("thinking", "Thinking…");
    let text;
    try {
      text = await transcribe(audio);
    } catch (error) {
      setVoiceState("idle", "Couldn't understand that. Try again.");
      await pause(1500);
      continue;
    }
    if (!text || !voice.active) continue;
    voiceEls.you.textContent = text;
    voiceEls.reply.textContent = "";

    const before = activeChat()?.messages.length || 0;
    await sendMessage(text);
    if (!voice.active) break;
    const chat = activeChat();
    if (!chat || chat.messages.length === before) continue; // message wasn't sent (e.g. the free limit)

    const toSay = spokenText(chat.messages.at(-1).content);
    voiceEls.reply.textContent = toSay;
    setVoiceState("speaking", "Speaking…");
    await speak(toSay);
  }
}

async function openVoiceMode() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    toast("Voice mode isn't supported in this browser. Try Chrome, Edge or Safari.");
    return;
  }
  try {
    voice.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    toast("Microphone access was blocked. Allow it in your browser settings to use voice mode.");
    return;
  }
  voice.audio = new AudioContext();
  voice.analyser = voice.audio.createAnalyser();
  voice.analyser.fftSize = 1024;
  voice.audio.createMediaStreamSource(voice.stream).connect(voice.analyser);
  speechSynthesis?.getVoices(); // starts loading voices early

  voice.active = true;
  voice.muted = false;
  window.voiceModeActive = true;
  voiceEls.you.textContent = "";
  voiceEls.reply.textContent = "";
  voiceEls.mute.setAttribute("aria-pressed", "false");
  voiceEls.mute.textContent = "Mute mic";
  voiceEls.dialog.showModal();
  voiceLoop();
}

function closeVoiceMode() {
  if (!voice.active) return;
  voice.active = false;
  window.voiceModeActive = false;
  stopSpeaking();
  voice.stopListening?.();
  if (isStreaming) controller?.abort();
  voice.stream?.getTracks().forEach((track) => track.stop());
  voice.audio?.close();
  if (voiceEls.dialog.open) voiceEls.dialog.close();
}

// Tap the orb: interrupt whatever is happening.
voiceEls.orb.onclick = () => {
  if (voice.speaking) stopSpeaking();           // stop talking → listen again
  else if (isStreaming) controller?.abort();    // stop thinking
  else voice.stopListening?.();                 // done talking → send now
};
voiceEls.mute.onclick = () => {
  voice.muted = !voice.muted;
  voiceEls.mute.setAttribute("aria-pressed", String(voice.muted));
  voiceEls.mute.textContent = voice.muted ? "Unmute mic" : "Mute mic";
  if (voice.muted) voice.stopListening?.();
};
document.getElementById("voice-end").onclick = closeVoiceMode;
voiceEls.dialog.addEventListener("close", closeVoiceMode); // Esc key
document.getElementById("voice-mode").onclick = openVoiceMode;
