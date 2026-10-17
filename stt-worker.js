// stt-worker.js — runs Whisper in its OWN process (Electron utilityProcess).
// Keeping it out of the main process means unticking "Voice input" can really
// give the memory back: the main process just kills this one.
//
// Messages in : { type: "load", repo, cacheDir } | { type: "transcribe", id, audio, language }
// Messages out: { type: "progress", percent, file } | { type: "ready" }
//               { type: "result", id, text } | { type: "error", id?, message }
"use strict";

const hasParentPort = !!process.parentPort;
const send = (m) => (hasParentPort ? process.parentPort.postMessage(m) : process.send(m));
const unwrap = (raw) => (hasParentPort && raw && raw.data !== undefined ? raw.data : raw);

let asr = null;
const files = new Map(); // file -> { loaded, total }  (for one overall percentage)

function onProgress(p) {
  if (!p || p.status !== "progress" || !p.file) return;
  files.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
  let loaded = 0;
  let total = 0;
  for (const f of files.values()) {
    loaded += f.loaded;
    total += f.total;
  }
  if (total > 0) send({ type: "progress", percent: Math.min(99, Math.round((loaded / total) * 100)), file: p.file });
}

async function load({ repo, cacheDir }) {
  const tf = require("@huggingface/transformers");
  tf.env.cacheDir = cacheDir;
  tf.env.allowLocalModels = false;
  asr = await tf.pipeline("automatic-speech-recognition", repo, {
    dtype: "q8", // quantised: roughly a third of the download, same accuracy for dictation
    device: "cpu",
    progress_callback: onProgress,
  });
  // Warm-up so the first real sentence is not slow.
  try {
    await asr(new Float32Array(16000));
  } catch {}
  send({ type: "ready" });
}

async function transcribe({ id, audio, language }) {
  if (!asr) throw new Error("Whisper is not loaded");
  const f32 = audio instanceof Float32Array ? audio : new Float32Array(audio.buffer ? audio.buffer : audio);
  const opts = { task: "transcribe", chunk_length_s: 30, stride_length_s: 5 };
  if (language && language !== "auto") opts.language = language;
  const out = await asr(f32, opts);
  const text = (Array.isArray(out) ? out.map((o) => o.text).join(" ") : out.text) || "";
  send({ type: "result", id, text: text.trim() });
}

async function handle(msg) {
  try {
    if (msg.type === "load") await load(msg);
    else if (msg.type === "transcribe") await transcribe(msg);
  } catch (e) {
    send({ type: "error", id: msg.id, message: (e && e.message) || String(e) });
  }
}

if (hasParentPort) process.parentPort.on("message", (e) => handle(unwrap(e)));
else process.on("message", (m) => handle(m));
