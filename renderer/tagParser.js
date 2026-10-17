// Parses emotion and motion tags from LLM replies, e.g. [happy], [blush], [nod].
// Ported from Project-Waifu (src/lib/tagParser.ts). Works with any model: the
// built-in tag lists below are only a baseline, and callers pass the loaded
// model's own expression/motion names as `vocab` so its tags are recognised
// and stripped too. UMD: browser global WaifuTagParser + Node module.

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WaifuTagParser = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Baseline vocabulary (common emotions/motions); a model's own names are
  // added through `vocab`.
  const BASE_EMOTIONS = [
    "angry", "confused", "crying", "embarrassed", "evil", "excited", "flirty", "happy",
    "sad", "scared", "smirk", "surprised", "thinking", "tipsy", "tired", "boba", "blush", "neutral",
  ];
  const BASE_MOTIONS = [
    "nod", "wave", "shake", "bow", "tilt", "laugh", "wink", "check_nails", "jiggle_dance",
    "sigh_tilt", "curious_glance", "stretch", "stretch_wave", "tail_wag",
  ];

  const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const clean = (arr) =>
    [...new Set((arr || []).map((t) => String(t).toLowerCase().trim()).filter((t) => /^[a-z0-9_ -]+$/.test(t)))];

  const cache = new Map();
  /** Build (and cache) the regexes for a vocabulary. */
  function buildRegexes(vocab) {
    const emotions = clean([...BASE_EMOTIONS, ...((vocab && vocab.emotions) || [])]);
    const motions = clean([...BASE_MOTIONS, ...((vocab && vocab.motions) || [])]);
    const key = emotions.join("|") + "#" + motions.join("|");
    let r = cache.get(key);
    if (!r) {
      const alt = (a) => a.map(escapeRe).join("|");
      r = {
        emotion: new RegExp("\\[(" + alt(emotions) + ")\\]", "gi"),
        motion: new RegExp("\\[(" + alt(motions) + ")\\]", "gi"),
        strip: new RegExp("(\\s*)\\[(" + alt([...emotions, ...motions]) + ")\\](\\s*)", "gi"),
      };
      cache.set(key, r);
    }
    return r;
  }

  function normalizeEmotion(raw) {
    const lower = raw.toLowerCase();
    if (lower === "blush") return "embarrassed";
    if (lower === "wink") return "flirty";
    if (lower === "neutral") return "neutral";
    return lower;
  }

  /**
   * @param {string} rawText
   * @param {string} [fallbackEmotion="neutral"]
   * @param {{emotions?: string[], motions?: string[]}} [vocab] the loaded model's own tag names
   * @returns {{cleanText: string, emotions: string[], motions: string[], primaryEmotion: string, primaryMotion: string}}
   */
  function parseEmotionAndMotionTags(rawText, fallbackEmotion = "neutral", vocab = null) {
    if (!rawText) {
      return {
        cleanText: "",
        emotions: [],
        motions: [],
        primaryEmotion: fallbackEmotion,
        primaryMotion: "none",
      };
    }

    const emotions = [];
    const motions = [];
    let match;

    const re = buildRegexes(vocab);
    const emReg = new RegExp(re.emotion.source, "gi");
    while ((match = emReg.exec(rawText)) !== null) {
      const e = normalizeEmotion(match[1]);
      if (!emotions.includes(e)) emotions.push(e);
    }

    const moReg = new RegExp(re.motion.source, "gi");
    while ((match = moReg.exec(rawText)) !== null) {
      const m = match[1].toLowerCase();
      if (!motions.includes(m)) motions.push(m);
    }

    // Drop tags, then tidy the whitespace they leave behind.
    const cleanText = rawText
      .replace(new RegExp(re.strip.source, "gi"), " ")
      .replace(/\s{2,}/g, " ")
      .replace(/ +([!?,.;:])/g, "$1")
      .trim();

    return {
      cleanText,
      emotions,
      motions,
      primaryEmotion: emotions.length > 0 ? emotions[0] : fallbackEmotion,
      primaryMotion: motions.length > 0 ? motions[0] : "none",
    };
  }

  // Any leftover "[stage direction]" the model invented (not in the vocabulary).
  function stripAnyTags(text) {
    return String(text || "")
      .replace(/\s*\[[A-Za-z][A-Za-z _'-]{0,39}\]\s*/g, " ")
      .replace(/\s*\[[A-Za-z _'-]{0,39}$/, "")
      .replace(/\s{2,}/g, " ")
      .replace(/ +([!?,.;:])/g, "$1")
      .trim();
  }

  return { parseEmotionAndMotionTags, stripAnyTags };
});
