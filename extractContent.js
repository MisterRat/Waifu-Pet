// Pure helper: extract assistant text from a /chat/completions-style response.
// Kept separate from ipc.js so it can be unit-tested without Electron.
"use strict";

/**
 * @param {any} data parsed JSON from a chat completions endpoint
 * @returns {string} the assistant's text, or "" if nothing found
 */
function extractContent(data) {
  if (!data || typeof data !== "object") return "";
  const msg = data.choices?.[0]?.message || data.message || {};
  let c = msg.content;
  if (Array.isArray(c)) {
    // OpenAI content parts: [{type:"text", text:"..."}]
    c = c
      .map((p) => (typeof p === "string" ? p : p?.text || ""))
      .join("");
  }
  if (typeof c === "string" && c.trim()) return c.trim();
  // Some backends nest differently
  const alt = data.choices?.[0]?.text || data.response || data.output;
  return typeof alt === "string" ? alt.trim() : "";
}

/**
 * Reassemble a reply from an SSE stream body ("data: {...}\n\n...") in case a
 * server ignores stream:false. Returns "" if no text events are found.
 */
function extractSseContent(raw) {
  if (!raw || typeof raw !== "string") return "";
  const parts = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      continue;
    }
    const c = obj.choices?.[0]?.message?.content ?? obj.choices?.[0]?.delta?.content;
    if (typeof c === "string") parts.push(c);
  }
  return parts.join("").trim();
}

/**
 * Incremental SSE parser for streamed chat completions. Feed it decoded text
 * chunks as they arrive (they may split lines anywhere); `onDelta` is called
 * with each piece of reply text.
 * @param {(text: string) => void} onDelta
 */
function createSseParser(onDelta) {
  let buf = "";
  const handleLine = (line) => {
    const t = line.trim();
    if (!t.startsWith("data:")) return;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      return;
    }
    const c = obj.choices?.[0]?.delta?.content ?? obj.choices?.[0]?.message?.content;
    if (typeof c === "string" && c) onDelta(c);
  };
  return {
    push(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        handleLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    },
    end() {
      if (buf) handleLine(buf);
      buf = "";
    },
  };
}

module.exports = { extractContent, extractSseContent, createSseParser };
