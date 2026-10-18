// conversation.js — hands-free conversation mode for the chat window.
// Ported from Project-Waifu's src/lib/conversationMode.ts (keep the two in sync).
//
// Listens through the microphone and uses the Silero voice-activity detector
// (running locally, in this window) to tell speech from noise and to decide when
// you have finished a sentence. The captured audio (16 kHz mono Float32) is handed
// to the caller for Whisper. The browser's noise suppression, echo cancellation
// and automatic gain are on for the microphone. Listening pauses while she is
// thinking or speaking (half-duplex), so she never hears and answers herself.
//
// UMD: a browser <script> (window.WaifuConversation) and Node (tests).

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WaifuConversation = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Runtime files are copied here from node_modules by scripts/copy-vendor.js
  // (npm install) and served by the app itself, never from the internet.
  const ASSET_PATH = "/vendor/vad/";

  // Same tuning as Project-Waifu.
  const VAD_OPTIONS = {
    model: "v5",
    // Speech probability thresholds recommended for Silero v5.
    positiveSpeechThreshold: 0.5,
    negativeSpeechThreshold: 0.35,
    // How long a pause ends your turn, and the shortest sound that counts as speech.
    redemptionMs: 900,
    minSpeechMs: 400,
    preSpeechPadMs: 300,
    submitUserSpeechOnPause: false,
  };

  /**
   * @param {object} opts
   * @param {(audio: Float32Array) => void} opts.onUtterance a finished sentence, 16 kHz mono
   * @param {(state: "starting"|"listening"|"hearing"|"paused"|"error") => void} opts.onState
   * @param {object} [opts.vad] the vad-web module (defaults to window.vad)
   * @returns {Promise<{resume: () => Promise<void>, pause: () => Promise<void>, destroy: () => void}>}
   */
  async function createConversationListener(opts) {
    const vadLib = opts.vad || (typeof self !== "undefined" && self.vad);
    if (!vadLib || !vadLib.MicVAD) throw new Error("voice detection files are missing (run npm install)");
    opts.onState("starting");
    const vad = await vadLib.MicVAD.new({
      ...VAD_OPTIONS,
      baseAssetPath: ASSET_PATH,
      onnxWASMBasePath: ASSET_PATH,
      startOnLoad: false,
      ortConfig: (ort) => {
        ort.env.logLevel = "error";
        ort.env.wasm.numThreads = 1; // no SharedArrayBuffer in this window
      },
      onSpeechRealStart: () => opts.onState("hearing"),
      onVADMisfire: () => opts.onState("listening"),
      onSpeechEnd: (audio) => {
        opts.onState("listening");
        opts.onUtterance(audio);
      },
    });

    let destroyed = false;
    return {
      resume: async () => {
        if (destroyed) return;
        await vad.start();
        opts.onState("listening");
      },
      pause: async () => {
        if (destroyed) return;
        await vad.pause();
        opts.onState("paused");
      },
      destroy: () => {
        destroyed = true;
        try {
          vad.destroy();
        } catch {
          /* already torn down */
        }
      },
    };
  }

  /**
   * Half-duplex gate: pauses the listener at once while she is busy (thinking,
   * speaking, or a sentence is being transcribed) and resumes it a moment after
   * she is done, so the tail of her voice is never heard as yours.
   */
  class HalfDuplexGate {
    /**
     * @param {object} opts
     * @param {() => any} opts.pause
     * @param {() => any} opts.resume
     * @param {number} [opts.resumeDelayMs=350]
     * @param {Function} [opts.setTimeout]
     * @param {Function} [opts.clearTimeout]
     */
    constructor(opts) {
      this.pause = opts.pause;
      this.resume = opts.resume;
      this.resumeDelayMs = opts.resumeDelayMs ?? 350;
      this._setTimeout = opts.setTimeout || setTimeout;
      this._clearTimeout = opts.clearTimeout || clearTimeout;
      this.timer = null;
      this.busy = null; // unknown until the first update
      this.listening = false; // the listener starts paused
    }

    /** Call whenever any of the busy signals changes. */
    update(busy) {
      busy = Boolean(busy);
      if (busy === this.busy) return;
      this.busy = busy;
      this._clearTimeout(this.timer);
      this.timer = null;
      if (busy) {
        if (this.listening) {
          this.listening = false;
          this.pause();
        }
      } else {
        this.timer = this._setTimeout(() => {
          this.timer = null;
          if (this.busy || this.listening) return;
          this.listening = true;
          this.resume();
        }, this.resumeDelayMs);
      }
    }

    stop() {
      this._clearTimeout(this.timer);
      this.timer = null;
      this.busy = null;
      this.listening = false;
    }
  }

  /** Status line for the chat window. */
  function statusLabel({ petSpeaking, thinking, transcribing, listenerState }, name) {
    const who = name || "She";
    if (petSpeaking) return { text: `${who} is speaking`, kind: "pet" };
    if (thinking) return { text: `${who} is thinking…`, kind: "pet" };
    if (transcribing) return { text: "Got it…", kind: "busy" };
    if (listenerState === "hearing") return { text: "Hearing you…", kind: "hearing" };
    if (listenerState === "starting") return { text: "Starting microphone…", kind: "busy" };
    if (listenerState === "listening") return { text: "Listening", kind: "listening" };
    return { text: "Paused", kind: "paused" };
  }

  return { createConversationListener, HalfDuplexGate, statusLabel, ASSET_PATH, VAD_OPTIONS };
});
