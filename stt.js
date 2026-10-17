// stt.js — built-in speech-to-text (Whisper via Transformers.js).
// Owns the lifecycle: download-on-first-use, load into a worker process, and
// unload (kill the process) when the user turns voice input off. No Electron
// imports, so it can be unit-tested with a fake worker.
"use strict";

const MODELS = {
  tiny: { repo: "Xenova/whisper-tiny", label: "Tiny", approxMB: 40 },
  base: { repo: "Xenova/whisper-base", label: "Base", approxMB: 80 },
  small: { repo: "Xenova/whisper-small", label: "Small", approxMB: 250 },
};
const DEFAULT_MODEL = "base";
const TRANSCRIBE_TIMEOUT_MS = 120000;

const normModel = (m) => (MODELS[m] ? m : DEFAULT_MODEL);

class SttService {
  /**
   * @param {{fork: () => any, cacheDir: string, onStatus?: (s: object) => void}} opts
   *   fork() must return an object with on('message'|'exit'), postMessage(m), kill()
   */
  constructor({ fork, cacheDir, onStatus }) {
    this.fork = fork;
    this.cacheDir = cacheDir;
    this.onStatus = onStatus || (() => {});
    this.child = null;
    this.model = null;
    this.pending = new Map();
    this.nextId = 1;
    this.status = { state: "off", model: DEFAULT_MODEL, percent: 0, message: "" };
  }

  _set(patch) {
    this.status = { ...this.status, ...patch };
    try {
      this.onStatus(this.status);
    } catch {}
  }

  /** Bring the service in line with the settings: load, switch model, or unload. */
  apply(cfg) {
    const enabled = !!(cfg && cfg.enabled);
    const model = normModel(cfg && cfg.model);
    if (!enabled) {
      if (this.child || this.status.state !== "off") this.unload();
      return;
    }
    if (this.child && this.model === model && this.status.state !== "error") return; // already loading/ready
    this.load(model);
  }

  load(model) {
    this.unload(true);
    this.model = model;
    this._set({ state: "loading", model, percent: 0, message: "Starting…" });
    let child;
    try {
      child = this.fork();
    } catch (e) {
      this._set({ state: "error", message: "Could not start Whisper: " + e.message });
      return;
    }
    this.child = child;
    child.on("message", (msg) => {
      if (child !== this.child || !msg) return;
      if (msg.type === "progress") {
        this._set({ state: "downloading", percent: msg.percent, message: `Downloading model… ${msg.percent}%` });
      } else if (msg.type === "ready") {
        this._set({ state: "ready", percent: 100, message: "Ready" });
      } else if (msg.type === "result" || (msg.type === "error" && msg.id)) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.type === "result") p.resolve(msg.text);
        else p.reject(new Error(msg.message));
      } else if (msg.type === "error") {
        this._set({ state: "error", message: msg.message });
        this._killChild();
      }
    });
    child.on("exit", (code) => {
      if (child !== this.child) return; // we killed it on purpose
      this.child = null;
      this._rejectAll(new Error("Whisper stopped unexpectedly"));
      this._set({ state: "error", message: `Whisper stopped unexpectedly (code ${code})` });
    });
    child.postMessage({ type: "load", repo: MODELS[model].repo, cacheDir: this.cacheDir });
  }

  _killChild() {
    const c = this.child;
    this.child = null;
    if (c) {
      try {
        c.kill();
      } catch {}
    }
    this._rejectAll(new Error("Voice input was turned off"));
  }

  _rejectAll(err) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  /** Free the model and its memory. `quiet` skips the status broadcast (used when reloading). */
  unload(quiet = false) {
    this._killChild();
    this.model = null;
    if (!quiet) this._set({ state: "off", percent: 0, message: "" });
  }

  /** @param {Float32Array} audio 16 kHz mono samples */
  transcribe(audio, language) {
    if (this.status.state !== "ready" || !this.child) {
      const s = this.status.state;
      const why =
        s === "off" ? "Voice input is turned off in Settings"
        : s === "error" ? this.status.message
        : "Whisper is still loading — try again in a moment";
      return Promise.reject(new Error(why));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Transcription timed out"));
      }, TRANSCRIBE_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.child.postMessage({ type: "transcribe", id, audio, language });
    });
  }
}

module.exports = { SttService, MODELS, DEFAULT_MODEL, normModel };
