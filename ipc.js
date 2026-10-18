// IPC handlers: settings get/save, OpenAI-compatible chat proxy (plain and
// streaming), TTS and speech-to-text proxies, model inspection.
// The renderer never talks to the LLM/TTS/STT servers directly — the main
// process proxies requests so API keys stay out of the renderer and CORS is a
// non-issue.
"use strict";
const { stripTags, cleanTranscript } = require("./speechText");

const { ipcMain } = require("electron");
const { extractContent, extractSseContent, createSseParser } = require("./extractContent");
const { listModels, resolveModelName, inspectModel } = require("./models");
const { modelOverride, publicView } = require("./settings");

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "").trim().replace(/\/+$/, "");
}

/** Build an endpoint URL ("/chat/completions", "/audio/speech", ...) from a user-supplied base URL. */
function endpointUrl(baseUrl, endpoint, label) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) throw new Error(`${label} base URL is not set`);
  if (base.endsWith(endpoint)) return base;
  if (base.endsWith("/v1")) return `${base}${endpoint}`;
  return `${base}/v1${endpoint}`;
}
const chatCompletionsUrl = (b) => endpointUrl(b, "/chat/completions", "Chat");
const ttsSpeechUrl = (b) => endpointUrl(b, "/audio/speech", "TTS");

// Local models can be slow to answer, so chat gets a long timeout; it just must
// not hang forever when the backend is down/stuck.
const CHAT_TIMEOUT_MS = 120000;
const STREAM_IDLE_MS = 120000; // max silence between streamed chunks
const TTS_TIMEOUT_MS = 60000;
const TEST_TIMEOUT_MS = 15000;
const MAX_AUDIO_SAMPLES = 16000 * 120; // 2 minutes at 16 kHz
const MIN_AUDIO_SAMPLES = 16000 * 0.4;

/** fetch() with a timeout and a readable error when it fires. */
async function timedFetch(url, init, ms) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch (e) {
    if (e && (e.name === "TimeoutError" || e.name === "AbortError")) {
      let host = url;
      try {
        host = new URL(url).host;
      } catch {}
      throw new Error(`${host} did not respond within ${Math.round(ms / 1000)}s`);
    }
    throw e;
  }
}

/** Validate/clean chat messages coming from a renderer (untrusted input). */
function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) throw new Error("messages must be an array");
  const ROLES = new Set(["system", "user", "assistant"]);
  return messages.slice(-200).map((m) => {
    if (!m || !ROLES.has(m.role)) throw new Error("invalid message role");
    return { role: m.role, content: String(m.content ?? "").slice(0, 20000) };
  });
}

/**
 * Only the settings window may read/write API keys. Checks the full origin
 * (our own local server) as well as the page, when the origin is known.
 * @param {object} e IPC event
 * @param {string} [origin] e.g. "http://127.0.0.1:51234"
 */
function isSettingsSender(e, origin) {
  return isPageSender(e, origin, "/chat/settings.html");
}

/** True when the IPC message came from our own page at `pathname`. */
function isPageSender(e, origin, pathname) {
  try {
    const url = (e.senderFrame && e.senderFrame.url) || e.sender.getURL();
    const u = new URL(url);
    if (origin && u.origin !== origin) return false;
    return u.pathname === pathname;
  } catch {
    return false;
  }
}

function authHeaders(apiKey) {
  const h = { "Content-Type": "application/json" };
  if (apiKey && apiKey.trim()) h["Authorization"] = `Bearer ${apiKey.trim()}`;
  return h;
}

function errorFromResponse(res, rawText, data) {
  const msg = (data && (data.error?.message || data.error)) || rawText.slice(0, 300) || `Chat API returned status ${res.status}`;
  return new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
}

function chatBody(chat, messages, extra) {
  return JSON.stringify({
    model: String(chat.model || "").trim(),
    messages,
    temperature: typeof chat.temperature === "number" ? chat.temperature : 0.8,
    ...extra,
  });
}

/** One non-streaming chat completion. Returns the reply text. */
async function completeChat(cfg, messages, extra = {}) {
  const { chat } = cfg;
  const res = await timedFetch(
    chatCompletionsUrl(chat.baseUrl),
    { method: "POST", headers: authHeaders(chat.apiKey), body: chatBody(chat, messages, extra) },
    CHAT_TIMEOUT_MS
  );
  const rawText = await res.text();
  let data = {};
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch {
    data = {};
  }
  if (!res.ok) throw errorFromResponse(res, rawText, data);
  // extractSseContent: some servers stream even when asked not to.
  const content = extractContent(data) || extractSseContent(rawText);
  if (!content) throw new Error("Model returned an empty reply (raw: " + (rawText || "<empty body>").slice(0, 300) + ")");
  return content;
}

/**
 * Streaming chat completion: calls onDelta(text) for each piece as it arrives
 * and resolves with the full reply. Falls back to a single delta if the server
 * ignores `stream: true`. `signal` cancels the request.
 */
async function streamChat(cfg, messages, { onDelta, signal }) {
  const { chat } = cfg;
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener("abort", onAbort);
  }
  let idle;
  const bump = () => {
    clearTimeout(idle);
    idle = setTimeout(() => ctl.abort(), STREAM_IDLE_MS);
  };
  bump();
  try {
    const res = await fetch(chatCompletionsUrl(chat.baseUrl), {
      method: "POST",
      headers: { ...authHeaders(chat.apiKey), Accept: "text/event-stream" },
      body: chatBody(chat, messages, { stream: true }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      const rawText = await res.text().catch(() => "");
      let data = {};
      try {
        data = JSON.parse(rawText);
      } catch {}
      throw errorFromResponse(res, rawText, data);
    }
    if (!(res.headers.get("content-type") || "").includes("text/event-stream")) {
      const raw = await res.text();
      let data = {};
      try {
        data = JSON.parse(raw);
      } catch {}
      const c = extractContent(data) || extractSseContent(raw);
      if (!c) throw new Error("Model returned an empty reply");
      onDelta(c);
      return c;
    }
    let full = "";
    const parser = createSseParser((t) => {
      full += t;
      onDelta(t);
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bump();
      parser.push(dec.decode(value, { stream: true }));
    }
    parser.end();
    if (!full.trim()) throw new Error("Model returned an empty reply");
    return full;
  } catch (e) {
    if (ctl.signal.aborted && !(signal && signal.aborted)) {
      throw new Error(`The chat server stopped responding (${STREAM_IDLE_MS / 1000}s)`);
    }
    throw e;
  } finally {
    clearTimeout(idle);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

/** Expression/motion tag names of a model (folder name), for prompts and parsing. */
function modelVocab(name) {
  const m = listModels().find((x) => x.name === name);
  if (!m) return { name: name || "", emotions: [], motions: [] };
  const base = (f) => f.replace(/^.*\//, "").replace(/\.(exp3|motion3)\.json$/i, "").toLowerCase();
  return {
    name: m.name,
    // Emotions mapped in waifu-faces.json stay usable as tags (e.g. [crying] -> Sad face).
    emotions: [...new Set([...m.expressions.map(base), ...Object.keys((m.faces && m.faces.map) || {}).map((k) => k.toLowerCase())])],
    motions: m.motions.map(base).filter((n) => !/^idle/.test(n) && n !== "blink"),
  };
}

/** Tells the LLM exactly which tags exist for this body (no hard-coded list). */
function tagInstructions(v) {
  const fmt = (list) => list.map((t) => "[" + t + "]").join(", ");
  const parts = [];
  if (v.emotions.length) parts.push("emotion tags: " + fmt(v.emotions));
  if (v.motions.length) parts.push("motion tags: " + fmt(v.motions));
  if (!parts.length) return "";
  return (
    "\n\nYou can show feelings and move by putting tags in square brackets in your reply. " +
    "Use ONLY these tags (anything else is ignored) — " +
    parts.join("; ") +
    "."
  );
}

/** Full system prompt for a model: persona (per-model override or global) + its tags. */
function buildSystemPrompt(cfg, modelName) {
  const base =
    modelOverride(cfg.models, modelName, "systemPrompt") ||
    (cfg.chat.systemPrompt || "").trim() ||
    "You are a cheerful anime desktop pet.";
  return base + tagInstructions(modelVocab(modelName));
}

function safeSend(wc, channel, payload) {
  try {
    if (wc && !wc.isDestroyed()) wc.send(channel, payload);
  } catch {
    /* window closed mid-stream */
  }
}

/**
 * @param {object} settings SettingsStore
 * @param {{getLoadedModel?: () => (string|null), onSettingsChanged?: () => void}} [hooks]
 */
function registerIpc(settings, hooks = {}) {
  const fromSettings = (e) => isSettingsSender(e, hooks.getOrigin && hooks.getOrigin());
  const fromChat = (e) => isPageSender(e, hooks.getOrigin && hooks.getOrigin(), "/chat/index.html");
  const activeModel = () => (hooks.getLoadedModel && hooks.getLoadedModel()) || resolveModelName(settings.get());

  // API keys only go to the settings window; the pet and chat windows get a
  // redacted copy (they proxy through main and never need the keys).
  ipcMain.handle("settings:get", (e) => (fromSettings(e) ? settings.get() : publicView(settings.get())));

  ipcMain.handle("settings:update", (e, partial) => {
    if (!fromSettings(e)) throw new Error("settings can only be changed from the settings window");
    settings.update(partial);
    if (hooks.onSettingsChanged) hooks.onSettingsChanged();
    return settings.get();
  });

  // Available Live2D models (subfolders of ./models/ with a .model3.json).
  // Read from disk on every call so models dropped into models/ appear without
  // restarting the app.
  ipcMain.handle("models:list", () => listModels());
  ipcMain.handle("models:vocab", () => modelVocab(activeModel()));

  // --- Saved conversation, per model (chat window only) ---
  // The chat window names the model it is showing, so a reply that finishes
  // after a model switch is saved with the model it belongs to.
  const history = hooks.history;
  const notChat = () => new Error("chat history is only available to the chat window");
  ipcMain.handle("history:get", (e) => {
    if (!fromChat(e)) throw notChat();
    const model = activeModel();
    return { model, messages: history ? history.get(model) : [] };
  });
  ipcMain.handle("history:append", (e, payload) => {
    if (!fromChat(e)) throw notChat();
    if (history && payload) history.append(String(payload.model || ""), payload.messages);
    return true;
  });
  ipcMain.handle("history:clear", (e, payload) => {
    if (!fromChat(e)) throw notChat();
    if (history && payload) history.clear(String(payload.model || ""));
    return true;
  });
  ipcMain.handle("models:inspect", (_e, name) => inspectModel(String(name || "")));

  // System prompt for the model that is currently loaded (persona + its tags).
  ipcMain.handle("chat:system-prompt", () => buildSystemPrompt(settings.get(), activeModel()));

  // --- Chat: { messages: [{role, content}] } -> { content } ---
  ipcMain.handle("chat:send", async (_e, payload) => {
    const messages = sanitizeMessages(payload && payload.messages);
    return { content: await completeChat(settings.get(), messages) };
  });

  // --- Streaming chat: returns { id } immediately; text arrives as
  // "chat:delta" {id, text} events and finishes with "chat:done" {id, error?, cancelled?}.
  const streams = new Map();
  let streamSeq = 0;
  ipcMain.handle("chat:stream", (e, payload) => {
    const messages = sanitizeMessages(payload && payload.messages);
    const id = ++streamSeq;
    const ctl = new AbortController();
    streams.set(id, ctl);
    const sender = e.sender;
    (async () => {
      try {
        await streamChat(settings.get(), messages, {
          signal: ctl.signal,
          onDelta: (text) => safeSend(sender, "chat:delta", { id, text }),
        });
        safeSend(sender, "chat:done", { id });
      } catch (err) {
        safeSend(sender, "chat:done", ctl.signal.aborted ? { id, cancelled: true } : { id, error: err.message });
      } finally {
        streams.delete(id);
      }
    })();
    return { id };
  });
  ipcMain.on("chat:cancel", (_e, id) => {
    const ctl = streams.get(id);
    if (ctl) ctl.abort();
  });

  // Voice for the active pet model: per-model override, else the global TTS voice.
  const activeVoice = () => {
    const { tts, models } = settings.get();
    return modelOverride(models, activeModel(), "voice") || tts.voice?.trim() || "af";
  };

  const ttsRequest = (tts, input, speed) =>
    timedFetch(
      ttsSpeechUrl(tts.baseUrl),
      {
        method: "POST",
        headers: authHeaders(tts.apiKey),
        body: JSON.stringify({
          model: String(tts.model || "").trim() || "kokoro",
          input,
          voice: activeVoice(),
          response_format: "mp3",
          speed,
        }),
      },
      input === "Hi!" ? TEST_TIMEOUT_MS : TTS_TIMEOUT_MS
    );

  // --- TTS: { text } -> { audioBase64, mimeType } ---
  ipcMain.handle("tts:speak", async (_e, payload) => {
    const { tts } = settings.get();
    const input = stripTags(String((payload && payload.text) || "")).slice(0, 5000);
    if (!tts.enabled || !input) return { audioBase64: null, mimeType: null };
    const res = await ttsRequest(tts, input, typeof tts.speed === "number" ? tts.speed : 1.0);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`TTS API returned status ${res.status}: ${body.slice(0, 200)}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { audioBase64: buf.toString("base64"), mimeType: res.headers.get("content-type") || "audio/mpeg" };
  });

  // --- Speech-to-text (built-in Whisper): { audio: Float32Array @16 kHz } -> { text } ---
  ipcMain.handle("stt:status", () => (hooks.stt ? hooks.stt.status : { state: "off", model: "base", percent: 0, message: "" }));

  ipcMain.handle("stt:transcribe", async (_e, payload) => {
    const { stt } = settings.get();
    if (!stt.enabled || !hooks.stt) throw new Error("Voice input is turned off in Settings");
    const a = payload && payload.audio;
    const samples = a instanceof Float32Array ? a : ArrayBuffer.isView(a) ? new Float32Array(a.buffer, a.byteOffset, a.byteLength >> 2) : null;
    if (!samples || samples.length > MAX_AUDIO_SAMPLES) throw new Error("Recording is missing or too long (2 minutes max)");
    if (samples.length < MIN_AUDIO_SAMPLES) throw new Error("Recording was too short");
    // Drop noise tags and the phrases Whisper invents from near-silence.
    const text = cleanTranscript(await hooks.stt.transcribe(samples, stt.language), samples.length / 16000);
    if (!text) throw new Error("No speech was recognised");
    return { text };
  });

  // --- Health checks for the settings window ---
  ipcMain.handle("tts:test", async () => {
    const { tts } = settings.get();
    try {
      const res = await ttsRequest(tts, "Hi!", 1.0);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { ok: false, error: `Status ${res.status}: ${body.slice(0, 200)}` };
      }
      await res.arrayBuffer();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle("chat:test", async () => {
    try {
      const reply = await completeChatTest(settings.get());
      return { ok: true, reply };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

async function completeChatTest(cfg) {
  const { chat } = cfg;
  const res = await timedFetch(
    chatCompletionsUrl(chat.baseUrl),
    {
      method: "POST",
      headers: authHeaders(chat.apiKey),
      body: JSON.stringify({
        model: String(chat.model || "").trim(),
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
        max_tokens: 8,
      }),
    },
    TEST_TIMEOUT_MS
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && (data.error?.message || data.error)) || `Status ${res.status}`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return extractContent(data);
}

module.exports = {
  registerIpc,
  completeChat,
  streamChat,
  buildSystemPrompt,
  tagInstructions,
  modelVocab,
  chatCompletionsUrl,
  ttsSpeechUrl,
};
