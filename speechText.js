// Pure helper: make text safe to SPEAK and to show. Models invent tags that are
// not in the loaded model's vocabulary ([giggle], [soft smile] ...), and the
// vocabulary-based parser leaves those in. Nothing in square brackets that
// looks like a stage direction should ever be read out by TTS.
"use strict";

// "[word]" / "[two words]" / "[snake_case]" up to 40 chars, letters only (so
// "[1]" citations and "[link](url)" style text with digits/URLs are untouched).
const TAG_RE = /\s*\[[A-Za-z][A-Za-z _'-]{0,39}\]\s*/g;
// A tag still being streamed: "[hap" at the very end.
const OPEN_TAG_RE = /\s*\[[A-Za-z _'-]{0,39}$/;

/** Remove every [tag] and tidy the whitespace left behind. */
function stripTags(text) {
  return String(text || "")
    .replace(TAG_RE, " ")
    .replace(OPEN_TAG_RE, "")
    .replace(/\s{2,}/g, " ")
    .replace(/ +([!?,.;:])/g, "$1")
    .trim();
}

// Phrases Whisper is known to invent for silence or noise (same list as
// Project-Waifu's src/lib/conversationMode.ts). They are only treated as
// phantoms on short clips, so a real "thank you" in a longer sentence survives.
const PHANTOM_PHRASES = new Set([
  "you",
  "thank you",
  "thanks",
  "thank you very much",
  "thanks for watching",
  "thank you for watching",
  "thank you for watching please subscribe",
  "please subscribe",
  "bye",
  "bye bye",
  "so",
  "okay",
  "uh",
  "um",
  "hmm",
  "the end",
]);

/**
 * Whisper's transcript tidied up, or "" if it is empty, only a bracketed noise
 * tag ("[Music]", "(coughs)", "*sigh*", "♪"), or a likely phantom phrase on a
 * clip under 1.5 s. Same rules as Project-Waifu's cleanTranscript.
 * @param {string} raw
 * @param {number} durationSec length of the recording
 */
function cleanTranscript(raw, durationSec) {
  const text = String(raw || "")
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const normalised = text.toLowerCase().replace(/[^a-z' ]/g, "").replace(/\s+/g, " ").trim();
  if (!normalised) return "";
  if (durationSec < 1.5 && PHANTOM_PHRASES.has(normalised)) return "";
  return text;
}

module.exports = { stripTags, cleanTranscript };
