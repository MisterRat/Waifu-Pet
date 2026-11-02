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

  // --- Code blocks: shown in the chat window, never spoken ---
  // The system prompt asks the LLM to put code in Markdown ``` fences. These
  // helpers split a reply into text and code, and give the part that may be read
  // aloud. They work on half-streamed replies too: an unclosed fence is code
  // until it closes.

  const FENCE = "```";
  // Marks where a code block sat in the speakable text: a sentence always ends
  // there, so she says "Here's the script:" without waiting for the code.
  const CODE_BREAK = "\u0001";

  /**
   * Split text into text and code segments.
   * @param {string} text
   * @returns {Array<{type: "text", text: string} | {type: "code", code: string, lang: string, open: boolean}>}
   *   open = the closing fence hasn't arrived yet (still streaming)
   */
  function codeSegments(text) {
    const s = String(text || "");
    const out = [];
    let i = 0;
    while (i < s.length) {
      const start = s.indexOf(FENCE, i);
      if (start < 0) {
        out.push({ type: "text", text: s.slice(i) });
        break;
      }
      if (start > i) out.push({ type: "text", text: s.slice(i, start) });
      let body = start + FENCE.length;
      // Optional language name on the fence line ("```python").
      const head = /^([\w+#.-]*)[ \t]*(\r?\n|$)/.exec(s.slice(body));
      let lang = "";
      if (head && (head[2] || body + head[0].length === s.length)) {
        lang = head[1];
        body += head[0].length;
      }
      const end = s.indexOf(FENCE, body);
      if (end < 0) {
        out.push({ type: "code", code: s.slice(body), lang, open: true });
        break;
      }
      out.push({ type: "code", code: s.slice(body, end).replace(/\r?\n$/, ""), lang, open: false });
      i = end + FENCE.length;
    }
    return out;
  }

  /** Text segment as speech: inline `code` keeps its words, loses the backticks. */
  const speakInline = (t) => t.replace(/`+/g, "");

  /**
   * The part of a (possibly half-streamed) reply that may be spoken. Each code
   * block becomes a CODE_BREAK and the text stops at a fence that hasn't closed.
   * As the reply grows, earlier output stays a prefix of later output, so a
   * streaming caller can keep an offset into it.
   */
  function speakableStream(text) {
    let out = "";
    for (const seg of codeSegments(text)) {
      if (seg.type === "text") out += speakInline(seg.text);
      else out += CODE_BREAK;
    }
    return out;
  }

  /** A whole reply with its code removed, ready to speak. */
  function stripCode(text) {
    return speakableStream(text)
      .split(CODE_BREAK)
      .map((t) => t.trim())
      .filter(Boolean)
      .join(" ");
  }

  /**
   * Take complete sentences off the front of streamed speakable text. A
   * sentence ends at . ! ? … followed by whitespace (so "3.5" is safe), at CJK
   * sentence punctuation, or where a code block sat. `final` also flushes the rest.
   * @returns {{sentences: string[], rest: string}}
   */
  function takeSentences(buf, final) {
    const out = [];
    let rest = buf;
    const re = /[\s\S]*?(?:[.!?…]+["'”’)\]]*(?=\s)|[。！？]+["'”’)\]]*|\u0001)/;
    for (;;) {
      const m = re.exec(rest);
      if (!m) break;
      out.push(m[0].replace(/\u0001/g, "").trim());
      rest = rest.slice(m[0].length);
    }
    if (final && rest.trim()) {
      out.push(rest.replace(/\u0001/g, "").trim());
      rest = "";
    }
    return { sentences: out.filter(Boolean), rest };
  }

  return { parseEmotionAndMotionTags, stripAnyTags, codeSegments, speakableStream, stripCode, takeSentences, CODE_BREAK };
});
