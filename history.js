// history.js — the saved conversation for each model, so she remembers what was
// said after the chat window (or the app) is closed. Same idea as
// Project-Waifu's per-persona chat history.
//
// Stored in <userData>/chat-history.json as { "<ModelFolder>": [{role, content}] },
// written atomically (temp file + rename) like settings.json.
"use strict";

const fs = require("fs");
const path = require("path");

const MAX_MESSAGES = 200; // per model; older messages are dropped
const MAX_CHARS = 20000; // per message (same cap as the chat proxy)
const ROLES = new Set(["user", "assistant"]);

/** Keep only well-formed messages, trimmed to the caps. */
function cleanMessages(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const m of list) {
    if (!m || !ROLES.has(m.role)) continue;
    const content = String(m.content ?? "").slice(0, MAX_CHARS);
    if (content.trim()) out.push({ role: m.role, content });
  }
  return out.slice(-MAX_MESSAGES);
}

const validModel = (name) =>
  typeof name === "string" && name.length > 0 && name.length <= 200 && !["__proto__", "constructor", "prototype"].includes(name);

class HistoryStore {
  /** @param {string} userDataDir */
  constructor(userDataDir) {
    this.file = path.join(userDataDir, "chat-history.json");
    this.data = Object.create(null);
    this.load();
  }

  load() {
    let raw = null;
    for (const f of [this.file, this.file + ".bak"]) {
      try {
        raw = JSON.parse(fs.readFileSync(f, "utf8"));
        break;
      } catch {
        /* missing or unreadable: try the backup, else start empty */
      }
    }
    this.data = Object.create(null);
    if (raw && typeof raw === "object") {
      for (const [model, list] of Object.entries(raw)) {
        if (validModel(model)) this.data[model] = cleanMessages(list);
      }
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      try {
        fs.copyFileSync(this.file, this.file + ".bak");
      } catch {}
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error("[history] save failed:", e.message);
    }
  }

  /** The saved conversation for a model (oldest first). */
  get(model) {
    return validModel(model) ? (this.data[model] || []).slice() : [];
  }

  /** Add messages to a model's conversation and save. */
  append(model, messages) {
    if (!validModel(model)) return [];
    const add = cleanMessages(messages);
    if (!add.length) return this.get(model);
    this.data[model] = cleanMessages([...(this.data[model] || []), ...add]);
    this.save();
    return this.get(model);
  }

  /** Forget a model's conversation. */
  clear(model) {
    if (!validModel(model) || !this.data[model]) return;
    delete this.data[model];
    this.save();
  }
}

module.exports = { HistoryStore, cleanMessages, MAX_MESSAGES };
