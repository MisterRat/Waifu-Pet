// lipsync.js — Web Audio formant lip-sync engine.
// Ported from Project-Waifu src/lib/lipSyncEngine.ts (plain JS, UMD).
// Drives ParamMouthOpenY / ParamMouthForm from TTS audio via an AnalyserNode.

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WaifuLipSync = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  class LipSyncEngine {
    constructor() {
      this.audioCtx = null;
      this.analyser = null;
      this.activeSourceNode = null;
      this.currentAudioElement = null;
      this.freqData = null;
      this.timeData = null;
      this.isSpeakingInternal = false;
      this.smoothedOpenY = 0;
      this.smoothedForm = 0;
      this.smoothedVolume = 0;
      this.pseudoSpeechTimer = null;
      this.pseudoSpeechStartTime = 0;
      this.isUsingPseudoSpeech = false;
    }

    getAudioContext() {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!this.audioCtx || this.audioCtx.state === "closed") {
        this.audioCtx = new AC();
      }
      if (this.audioCtx.state === "suspended") {
        this.audioCtx.resume().catch(() => {});
      }
      return this.audioCtx;
    }

    /**
     * Binds an HTMLAudioElement (TTS audio) to the Web Audio graph.
     * Returns a cleanup function.
     */
    attachAudioElement(audio) {
      this.stop();

      const ctx = this.getAudioContext();
      this.currentAudioElement = audio;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.12;
      this.analyser = analyser;

      this.freqData = new Uint8Array(analyser.frequencyBinCount);
      this.timeData = new Uint8Array(analyser.fftSize);

      let source = null;
      try {
        source = ctx.createMediaElementSource(audio);
        source.connect(analyser);
        analyser.connect(ctx.destination);
        this.activeSourceNode = source;
      } catch (err) {
        console.warn("[LipSync] MediaElementSource warning:", err);
      }

      this.isSpeakingInternal = true;
      this.isUsingPseudoSpeech = false;

      const cleanup = () => this.stop();
      audio.addEventListener("ended", cleanup, { once: true });
      audio.addEventListener("error", cleanup, { once: true });
      audio.addEventListener("pause", () => {
        if (audio.ended || audio.currentTime === 0) cleanup();
      });

      return cleanup;
    }

    /** Procedural cadence fallback (no audio element). Returns cleanup. */
    startSpeechUtterance(estimatedDurationMs = 3000) {
      this.stop();
      this.isSpeakingInternal = true;
      this.isUsingPseudoSpeech = true;
      this.pseudoSpeechStartTime = performance.now();
      return () => this.stop();
    }

    stop() {
      this.isSpeakingInternal = false;
      this.isUsingPseudoSpeech = false;
      if (this.pseudoSpeechTimer) {
        clearInterval(this.pseudoSpeechTimer);
        this.pseudoSpeechTimer = null;
      }
      this.currentAudioElement = null;
    }

    /**
     * Sampled each frame by the Pixi ticker.
     * @param {number} dtSeconds
     * @returns {{mouthOpenY: number, mouthForm: number, isSpeaking: boolean, rawVolume: number}}
     */
    update(dtSeconds = 0.016) {
      const dt = Math.min(0.05, Math.max(0.001, dtSeconds));

      if (!this.isSpeakingInternal) {
        this.smoothedOpenY += (0 - this.smoothedOpenY) * (1.0 - Math.pow(0.0001, dt));
        this.smoothedForm += (0 - this.smoothedForm) * (1.0 - Math.pow(0.001, dt));
        this.smoothedVolume += (0 - this.smoothedVolume) * (1.0 - Math.pow(0.0001, dt));
        if (this.smoothedOpenY < 0.005) this.smoothedOpenY = 0;
        if (Math.abs(this.smoothedForm) < 0.005) this.smoothedForm = 0;
        if (this.smoothedVolume < 0.005) this.smoothedVolume = 0;
        return {
          mouthOpenY: this.smoothedOpenY,
          mouthForm: this.smoothedForm,
          isSpeaking: false,
          rawVolume: this.smoothedVolume,
        };
      }

      // 1. Real-time spectrum analysis
      if (this.analyser && this.freqData && this.timeData && !this.isUsingPseudoSpeech) {
        this.analyser.getByteFrequencyData(this.freqData);
        this.analyser.getByteTimeDomainData(this.timeData);

        const binCount = this.analyser.frequencyBinCount;
        const sampleRate = (this.audioCtx && this.audioCtx.sampleRate) || 44100;
        const hzPerBin = sampleRate / 2 / binCount;

        let lowEnergy = 0, midEnergy = 0, highEnergy = 0, totalEnergy = 0;
        let lowCount = 0, midCount = 0, highCount = 0;

        for (let i = 0; i < binCount; i++) {
          const freq = i * hzPerBin;
          const val = this.freqData[i] / 255.0;
          totalEnergy += val;
          if (freq >= 200 && freq < 850) { lowEnergy += val; lowCount++; }
          else if (freq >= 850 && freq < 2800) { midEnergy += val; midCount++; }
          else if (freq >= 3200 && freq < 8000) { highEnergy += val; highCount++; }
        }

        const avgLow = lowCount > 0 ? lowEnergy / lowCount : 0;
        const avgMid = midCount > 0 ? midEnergy / midCount : 0;
        const avgHigh = highCount > 0 ? highEnergy / highCount : 0;
        const rawVol = totalEnergy / binCount;

        const noiseThreshold = 0.025;
        let targetOpenY = 0;
        let targetForm = 0;

        if (rawVol > noiseThreshold) {
          const speechSignal = Math.max(0, avgLow * 1.8 + avgMid * 0.8 - noiseThreshold);
          targetOpenY = Math.min(1.0, Math.pow(speechSignal * 2.2, 0.85));
          const spreadRatio = (avgMid * 1.5 + avgHigh * 0.8) - avgLow * 1.2;
          targetForm = Math.max(-1.0, Math.min(1.0, spreadRatio * 2.5));
        }

        const attackFactor = 1.0 - Math.pow(0.00001, dt);
        const decayFactor = 1.0 - Math.pow(0.005, dt);

        if (targetOpenY > this.smoothedOpenY) {
          this.smoothedOpenY += (targetOpenY - this.smoothedOpenY) * attackFactor;
        } else {
          this.smoothedOpenY += (targetOpenY - this.smoothedOpenY) * decayFactor;
        }

        const formSmoothFactor = 1.0 - Math.pow(0.001, dt);
        this.smoothedForm += (targetForm - this.smoothedForm) * formSmoothFactor;
        this.smoothedVolume = rawVol;

        return {
          mouthOpenY: Math.max(0, Math.min(1.0, this.smoothedOpenY)),
          mouthForm: Math.max(-1.0, Math.min(1.0, this.smoothedForm)),
          isSpeaking: true,
          rawVolume: this.smoothedVolume,
        };
      }

      // 2. Procedural syllable cadence fallback
      if (this.isUsingPseudoSpeech) {
        const elapsed = (performance.now() - this.pseudoSpeechStartTime) / 1000;
        const primarySyllable = Math.sin(elapsed * 18.0) * 0.5 + 0.5;
        const subHarmonic = Math.cos(elapsed * 8.5) * 0.3;
        const microPause = Math.sin(elapsed * 3.2) > 0.75 ? 0.2 : 1.0;

        const targetOpenY = Math.max(0, (primarySyllable * 0.75 + subHarmonic * 0.25) * microPause);
        const targetForm = Math.sin(elapsed * 6.0) * 0.4;

        const attackFactor = 1.0 - Math.pow(0.0001, dt);
        this.smoothedOpenY += (targetOpenY - this.smoothedOpenY) * attackFactor;
        this.smoothedForm += (targetForm - this.smoothedForm) * attackFactor;

        return {
          mouthOpenY: this.smoothedOpenY,
          mouthForm: this.smoothedForm,
          isSpeaking: true,
          rawVolume: this.smoothedOpenY * 0.6,
        };
      }

      return { mouthOpenY: 0, mouthForm: 0, isSpeaking: false, rawVolume: 0 };
    }
  }

  return { LipSyncEngine, lipSyncEngine: new LipSyncEngine() };
});
