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

module.exports = { stripTags };
