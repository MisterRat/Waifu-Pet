// chat.js — chat window logic: streaming replies spoken sentence by sentence,
// voice input, and unprompted lines from the pet.
"use strict";

const $ = (id) => document.getElementById(id);
const messagesEl = $("messages");
const input = $("input");
const sendBtn = $("send");
const speakBtn = $("speak");
const micBtn = $("mic");

let history = []; // [{role, content}]
let systemPrompt = "You are a cheerful anime desktop pet.";
let vocab = { name: "", emotions: [], motions: [] }; // tags of the loaded model
let cfg = { chat: {}, stt: {} };
let speakOn = true;
let busy = false;
let current = null; // the reply currently streaming: { id, early, onDelta, onDone, cancel }

// Refresh settings, the model's tag list and the system prompt (the model or
// its per-model prompt may have changed since the last message).
async function refreshPrompt() {
  try {
    const [s, v, p] = await Promise.all([
      window.pet.settingsGet(),
      window.pet.modelsVocab(),
      window.pet.chatSystemPrompt(),
    ]);
    cfg = s;
    vocab = v || vocab;
    systemPrompt = p || systemPrompt;
    micBtn.hidden = !(s.stt && s.stt.enabled);
    if (vocab.name) {
      $("petName").textContent = vocab.name;
      input.placeholder = "Say something to " + vocab.name + "…";
    }
  } catch {
    /* keep previous values */
  }
}

// Text as the user should see it: [tags] removed, and a tag that is still being
// streamed (e.g. "[hap") hidden until it completes.
function displayText(raw) {
  const parsed = window.WaifuTagParser.parseEmotionAndMotionTags(raw, "neutral", vocab);
  return window.WaifuTagParser.stripAnyTags(parsed.cleanText);
}

function addMsg(role, text) {
  const div = document.createElement("div");
  div.className = "msg " + (role === "user" ? "user" : role === "assistant" ? "pet" : "sys");
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

// Split streamed text into complete sentences. A sentence ends at . ! ? …
// followed by whitespace (so "3.5" is safe), or at CJK sentence punctuation.
// `final` also flushes whatever is left.
function takeSentences(buf, final) {
  const out = [];
  let rest = buf;
  const re = /[\s\S]*?(?:[.!?…]+["'”’)\]]*(?=\s)|[。！？]+["'”’)\]]*)/;
  for (;;) {
    const m = re.exec(rest);
    if (!m) break;
    out.push(m[0].trim());
    rest = rest.slice(m[0].length);
  }
  if (final && rest.trim()) {
    out.push(rest.trim());
    rest = "";
  }
  return { sentences: out.filter(Boolean), rest };
}

// Stream events are routed to whichever reply is in flight. Events can arrive
// before chatStream() resolves with its id, so they are buffered until then.
window.pet.onChatDelta((e) => {
  if (!current) return;
  if (current.id == null) current.early.push(["delta", e]);
  else if (e.id === current.id) current.onDelta(e.text);
});
window.pet.onChatDone((e) => {
  if (!current) return;
  if (current.id == null) current.early.push(["done", e]);
  else if (e.id === current.id) current.onDone(e);
});

// Stream one reply. Sentences are handed to the pet as soon as they are
// complete so she starts talking before the answer is finished.
async function streamReply(apiMessages, bubble) {
  return new Promise((resolve) => {
    let acc = "";
    let sent = 0; // chars of `acc` already given to the pet
    let sentenceCount = 0;
    let cancelled = false;

    const flush = (final) => {
      const { sentences, rest } = takeSentences(acc.slice(sent), final);
      for (const text of sentences) {
        window.pet.pushLine({ text, speak: speakOn, append: sentenceCount > 0 });
        sentenceCount++;
      }
      sent = acc.length - rest.length;
    };

    const state = {
      id: null,
      early: [],
      cancel() {
        cancelled = true;
        if (state.id != null) window.pet.chatCancel(state.id);
        window.pet.pushLine({ text: "", speak: false }); // cut off her speech
      },
      onDelta(text) {
        acc += text;
        bubble.textContent = displayText(acc) || "…";
        messagesEl.scrollTop = messagesEl.scrollHeight;
        flush(false);
      },
      onDone(e) {
        if (e.error) {
          if (acc.trim()) bubble.textContent = displayText(acc) + "\n⚠ " + e.error;
          else {
            bubble.textContent = "⚠ " + e.error;
            bubble.classList.add("sys");
          }
        } else {
          if (!cancelled) flush(true);
          bubble.textContent = displayText(acc) || (cancelled ? "(stopped)" : "(no reply)");
        }
        resolve({ content: acc.trim(), cancelled });
      },
    };
    current = state;

    window.pet
      .chatStream(apiMessages)
      .then(({ id }) => {
        state.id = id;
        // Replay anything that raced ahead of the id.
        for (const [kind, e] of state.early.splice(0)) {
          if (e.id !== id) continue;
          if (kind === "delta") state.onDelta(e.text);
          else state.onDone(e);
        }
      })
      .catch((e) => state.onDone({ error: (e && e.message) || String(e) }));
  });
}

async function send() {
  if (busy) {
    // The button doubles as "Stop" while a reply is streaming.
    if (current) current.cancel();
    return;
  }
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  addMsg("user", text);
  history.push({ role: "user", content: text });

  busy = true;
  sendBtn.textContent = "Stop";
  const bubble = addMsg("assistant", "…");
  try {
    await refreshPrompt();
    const apiMessages = [{ role: "system", content: systemPrompt }, ...history.slice(-10)];

    if (cfg.chat && cfg.chat.stream === false) {
      // Non-streaming: wait for the whole reply, then act it out in one go.
      const res = await window.pet.chatSend(apiMessages);
      const content = (res && res.content) || "(no reply)";
      bubble.textContent = displayText(content) || content;
      history.push({ role: "assistant", content });
      window.pet.pushLine({ text: content, speak: speakOn });
    } else {
      const { content } = await streamReply(apiMessages, bubble);
      current = null;
      if (content) history.push({ role: "assistant", content });
    }
  } catch (e) {
    bubble.textContent = "⚠ " + (e && e.message ? e.message : String(e));
    bubble.classList.add("sys");
  } finally {
    current = null;
    busy = false;
    sendBtn.textContent = "Send";
    input.focus();
  }
}

sendBtn.addEventListener("click", send);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") send();
});

speakBtn.addEventListener("click", () => {
  speakOn = !speakOn;
  speakBtn.textContent = speakOn ? "🔊" : "🔇";
  speakBtn.classList.toggle("off", !speakOn);
});

// --- Voice input: click to record, click again to stop; the recording is
// transcribed by the speech-to-text server and (optionally) sent straight away.
let recorder = null;
let recordLimit = null;

// Whisper wants 16 kHz mono float samples: decode the recording and resample.
async function toWhisperAudio(blob) {
  const ctx = new AudioContext();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  } finally {
    ctx.close();
  }
  const frames = Math.max(1, Math.ceil(decoded.duration * 16000));
  const offline = new OfflineAudioContext(1, frames, 16000);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination); // multi-channel input is down-mixed to mono
  src.start();
  return (await offline.startRendering()).getChannelData(0);
}

async function transcribe(blob) {
  micBtn.disabled = true;
  const oldPlaceholder = input.placeholder;
  input.placeholder = "Transcribing…";
  try {
    const audio = await toWhisperAudio(blob);
    // Whisper invents text ("Thank you.") from silence, so skip near-silent clips.
    let sum = 0;
    for (let i = 0; i < audio.length; i++) sum += audio[i] * audio[i];
    if (Math.sqrt(sum / audio.length) < 0.003) throw new Error("No speech was detected");
    const { text } = await window.pet.sttTranscribe(audio);
    input.value = text;
    if (cfg.stt && cfg.stt.autoSend !== false) send();
    else input.focus();
  } catch (e) {
    addMsg("sys", "⚠ " + ((e && e.message) || e));
  } finally {
    micBtn.disabled = false;
    input.placeholder = oldPlaceholder;
  }
}

// Reflect the built-in Whisper's state on the mic button.
function showSttStatus(st) {
  if (!st) return;
  const ready = st.state === "ready";
  micBtn.disabled = !ready;
  micBtn.title =
    ready ? "Voice input"
    : st.state === "downloading" ? `Downloading Whisper… ${st.percent}%`
    : st.state === "loading" ? "Loading Whisper…"
    : st.state === "error" ? "Whisper error: " + st.message
    : "Voice input is turned off";
}
window.pet.onSttStatus(showSttStatus);
window.pet.sttStatus().then(showSttStatus).catch(() => {});

micBtn.addEventListener("click", async () => {
  if (recorder) {
    recorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find((t) => MediaRecorder.isTypeSupported(t));
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mr.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      clearTimeout(recordLimit);
      micBtn.classList.remove("rec");
      recorder = null;
      transcribe(new Blob(chunks, { type: mr.mimeType || "audio/webm" }));
    };
    recorder = mr;
    mr.start();
    micBtn.classList.add("rec");
    window.pet.pushLine({ text: "", speak: false }); // stop talking while the user speaks
    recordLimit = setTimeout(() => mr.state === "recording" && mr.stop(), 60000);
  } catch (e) {
    addMsg("sys", "Microphone unavailable: " + ((e && e.message) || e));
  }
});

// An unprompted line from the pet (greeting, remark): show it in the log and
// remember it as part of the conversation.
window.pet.onAssistantLine(({ text }) => {
  addMsg("assistant", displayText(text) || text);
  history.push({ role: "assistant", content: text });
});

$("close").addEventListener("click", () => window.pet.closeChat());

window.pet
  .settingsGet()
  .then(async (s) => {
    await refreshPrompt();
    speakOn = s.tts.enabled !== false;
    speakBtn.textContent = speakOn ? "🔊" : "🔇";
    speakBtn.classList.toggle("off", !speakOn);
  })
  .catch(() => {});

input.focus();
refreshPrompt();
