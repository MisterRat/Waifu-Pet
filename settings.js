// JSON settings persistence in Electron's userData directory.
// No API keys are ever written outside this local file, and when the OS
// offers encrypted storage (Windows DPAPI via Electron safeStorage) the keys
// are encrypted at rest inside it.
"use strict";

const fs = require("fs");
const path = require("path");

// Earlier default prompt(s) that hard-coded one model's tag list. A saved prompt
// that is still exactly one of these was never customised, so it is upgraded.
const LEGACY_PROMPTS = ["You are a cheerful, playful anime girl who lives on the user's desktop as a little pet. Keep replies short (1-3 sentences) and speak in first person. You may include emotion tags in square brackets to express how you feel, e.g. [happy], [sad], [excited], [angry], [confused], [crying], [embarrassed], [evil], [flirty], [scared], [smirk], [surprised], [thinking], [tipsy], [tired], [boba]. You may include motion tags in square brackets to make yourself move, e.g. [nod], [shake], [bow], [tilt], [wink], [wave], [laugh], [curious_glance], [jiggle_dance], [stretch], [sigh_tilt], [check_nails], [tail_wag]. Only use tags you actually feel. The tags are not spoken aloud."];

const DEFAULTS = {
  // OpenAI-compatible chat backend
  chat: {
    baseUrl: "http://localhost:3000/v1", // e.g. OpenWebUI, Ollama, LM Studio, vLLM, OpenAI
    apiKey: "",
    model: "",
    temperature: 0.8,
    // Stream the reply: text appears as it is written and she starts speaking
    // sentence by sentence instead of waiting for the whole answer.
    stream: true,
    // Tag names are NOT listed here: the chat window appends the loaded
    // model's own expression/motion tags automatically.
    systemPrompt:
      "You are a cheerful, playful anime girl who lives on the user's desktop as a " +
      "little pet. Keep replies short (1-3 sentences) and speak in first person. " +
      "Only use emotion or motion tags you actually feel. The tags are not spoken aloud.",
  },
  // TTS (OpenAI-compatible /audio/speech, e.g. Kokoro)
  tts: {
    enabled: true,
    baseUrl: "http://localhost:8000/v1",
    apiKey: "",
    model: "kokoro",
    voice: "af_bella(.1)+zf_xiaoni(.9)",
    speed: 1.0,
  },
  // Voice input: built-in Whisper (downloaded on first use, loaded only while enabled)
  stt: {
    enabled: false,
    model: "base", // tiny | base | small
    language: "auto", // "auto" or a Whisper language name, e.g. "english"
    autoSend: true, // send the transcript immediately
  },
  // Pet window
  pet: {
    model: "Tamamo", // model folder under ./models/ (bundled default; falls back to the first model found)
    scale: 1.0, // 0.5 .. 1.5
    alwaysOnTop: true,
    lookAtMouse: true, // eyes/head follow the cursor while it moves
    idleBehavior: true, // fidgets, glances and small mood changes when idle
    tailWagGain: 2.5, // multiplier on tail sway/wag amplitude (1 = the model's own motion)
  },
  // Unprompted behaviour: greetings, welcome-back and the occasional remark.
  proactive: {
    enabled: true,
    greetings: true, // time-of-day greeting at launch + "welcome back" after a long absence
    minMinutes: 20, // random gap between remarks
    maxMinutes: 45,
  },
  // Resource use
  perf: {
    maxFps: 30, // 0 = unlimited (display refresh rate)
    pauseWhenHidden: true, // stop rendering while the pet window is hidden
    hideOnFullscreen: true, // hide while a fullscreen game/video is running (Windows)
  },
  // Per-model overrides: { <ModelName>: { systemPrompt?, voice?, framing? } }.
  // Empty/missing values fall back to the global chat.systemPrompt / tts.voice.
  // framing = { zoom, x, y }: how the model sits in the window (x/y are
  // fractions of the window size; 0 = centered).
  models: {},
};

/**
 * Per-model override lookup. Returns the override string, or "" when the
 * model has no (non-empty) value for `key` — callers fall back to globals.
 */
function modelOverride(models, modelName, key) {
  const o = (models || {})[modelName];
  const v = o && o[key];
  return typeof v === "string" && v.trim() ? v : "";
}

function deepMerge(base, extra) {
  const out = { ...base };
  for (const k of Object.keys(extra || {})) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    if (
      extra[k] &&
      typeof extra[k] === "object" &&
      !Array.isArray(extra[k]) &&
      base[k] &&
      typeof base[k] === "object"
    ) {
      out[k] = deepMerge(base[k], extra[k]);
    } else if (extra[k] !== undefined) {
      out[k] = extra[k];
    }
  }
  return out;
}

// Fields stored encrypted on disk (when a secret store is available).
const SECRET_PATHS = [
  ["chat", "apiKey"],
  ["tts", "apiKey"],
];
const ENC_PREFIX = "enc:v1:";

/**
 * Copy of settings that is safe to hand to windows that don't need the keys:
 * api keys are blanked and replaced by an `apiKeySet` boolean.
 */
function publicView(data) {
  const out = JSON.parse(JSON.stringify(data));
  for (const [sec, key] of SECRET_PATHS) {
    if (out[sec]) {
      out[sec].apiKeySet = !!(out[sec][key] && String(out[sec][key]).trim());
      out[sec][key] = "";
    }
  }
  return out;
}

class SettingsStore {
  /**
   * @param {string} userDataDir
   * @param {{isAvailable(): boolean, encrypt(s: string): Buffer, decrypt(b: Buffer): string}} [secrets]
   *   optional encryption backend (Electron safeStorage)
   */
  constructor(userDataDir, secrets = null) {
    this.file = path.join(userDataDir, "settings.json");
    this.secrets = secrets;
    this.data = deepMerge(DEFAULTS, {});
    this.load();
  }

  _canEncrypt() {
    try {
      return !!(this.secrets && this.secrets.isAvailable());
    } catch {
      return false;
    }
  }

  _readFile(file) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }

  load() {
    let raw = null;
    try {
      raw = this._readFile(this.file);
    } catch (e) {
      if (e.code !== "ENOENT") {
        // Corrupt/unreadable: keep the evidence instead of overwriting it
        // with defaults on the next save, then try the last good backup.
        console.error("[settings] could not read settings.json:", e.message);
        try {
          fs.renameSync(this.file, this.file + ".corrupt-" + Date.now());
        } catch {}
        try {
          raw = this._readFile(this.file + ".bak");
          console.error("[settings] recovered from settings.json.bak");
        } catch {}
      }
    }
    if (!raw || typeof raw !== "object") return; // first run — defaults

    let needsMigration = false;
    for (const [sec, key] of SECRET_PATHS) {
      const v = raw[sec] && raw[sec][key];
      if (typeof v !== "string" || !v) continue;
      if (v.startsWith(ENC_PREFIX)) {
        try {
          raw[sec][key] = this.secrets.decrypt(Buffer.from(v.slice(ENC_PREFIX.length), "base64"));
        } catch (e) {
          console.error(`[settings] could not decrypt ${sec}.${key} (different Windows user?):`, e.message);
          raw[sec][key] = "";
        }
      } else if (this._canEncrypt()) {
        needsMigration = true; // legacy plaintext key: re-save encrypted
      }
    }
    this.data = deepMerge(DEFAULTS, raw);
    // Voice input used to be a remote OpenAI-style server (baseUrl/apiKey/model
    // "whisper-1"); it is now built-in, so drop those and fix the model name.
    if (this.data.stt) {
      for (const k of ["baseUrl", "apiKey"]) {
        if (k in this.data.stt) {
          delete this.data.stt[k];
          needsMigration = true;
        }
      }
      if (!["tiny", "base", "small"].includes(this.data.stt.model)) {
        this.data.stt.model = DEFAULTS.stt.model;
        needsMigration = true;
      }
    }
    if (LEGACY_PROMPTS.includes(this.data.chat.systemPrompt)) {
      this.data.chat.systemPrompt = DEFAULTS.chat.systemPrompt;
      needsMigration = true;
    }
    if (needsMigration) this.save();
  }

  save() {
    try {
      const out = JSON.parse(JSON.stringify(this.data));
      if (this._canEncrypt()) {
        for (const [sec, key] of SECRET_PATHS) {
          const v = out[sec] && out[sec][key];
          if (typeof v === "string" && v) {
            out[sec][key] = ENC_PREFIX + this.secrets.encrypt(v).toString("base64");
          }
        }
      }
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // Atomic write: temp file + rename, keeping the previous version as .bak,
      // so a crash mid-write can never leave a half-written settings.json.
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
      try {
        fs.copyFileSync(this.file, this.file + ".bak");
      } catch {}
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error("[settings] save failed:", e.message);
    }
  }

  get() {
    return this.data;
  }

  /** Merge a partial update (same shape as DEFAULTS) and persist. */
  update(partial) {
    if (!partial || typeof partial !== "object") return this.data;
    // Only known top-level sections are accepted.
    const clean = {};
    for (const k of Object.keys(DEFAULTS)) {
      if (partial[k] && typeof partial[k] === "object") clean[k] = partial[k];
    }
    this.data = deepMerge(this.data, clean);
    this.save();
    return this.data;
  }
}

module.exports = { SettingsStore, DEFAULTS, modelOverride, publicView };
