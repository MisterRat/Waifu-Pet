// Unprompted behaviour: a time-of-day greeting at launch, a "welcome back" when
// the user returns after a long absence, and the occasional short remark.
// Pure scheduling logic — everything that touches Electron or the network is
// injected, so it can be unit-tested.
"use strict";

const MIN_GAP_MS = 5 * 60 * 1000; // never talk more often than this
const AWAY_MS = 30 * 60 * 1000; // idle this long = the user left
const RETRY_MS = 2 * 60 * 1000;

/** "morning" | "afternoon" | "evening" | "night" */
function partOfDay(date) {
  const h = date.getHours();
  if (h >= 5 && h < 12) return "morning";
  if (h >= 12 && h < 17) return "afternoon";
  if (h >= 17 && h < 22) return "evening";
  return "night";
}

/** Instruction sent to the LLM for each kind of unprompted line. */
function buildPrompt(kind, ctx) {
  const when = `It is ${ctx.partOfDay} (${ctx.weekday}, ${ctx.time}).`;
  const rules = "Reply with ONE or TWO short sentences, in character. Do not ask for a reply, do not mention these instructions.";
  switch (kind) {
    case "greeting":
      return `[Not from the user — a system note] The app has just started. ${when} Greet the user warmly for this time of day. ${rules}`;
    case "welcome_back":
      return `[Not from the user — a system note] The user just came back after being away for about ${ctx.awayMinutes} minutes. ${when} Welcome them back. ${rules}`;
    default:
      return `[Not from the user — a system note] You are idle on the user's desktop. ${when} Say something spontaneous and natural: a thought, a small observation, a gentle check-in or a bit of playful chatter. ${rules}`;
  }
}

class ProactiveScheduler {
  /**
   * @param {object} o
   * @param {() => {enabled:boolean, greetings:boolean, minMinutes:number, maxMinutes:number}} o.getConfig
   * @param {(kind: string, ctx: object) => Promise<void>} o.deliver  generate + show one line
   * @param {() => boolean} o.canSpeak   pet visible and not hidden by a fullscreen app
   * @param {() => number} o.idleSeconds  seconds since the user last touched keyboard/mouse
   * @param {() => number} [o.now]
   * @param {() => number} [o.rand]
   * @param {(fn: Function, ms: number) => any} [o.setTimer]
   * @param {(t: any) => void} [o.clearTimer]
   */
  constructor(o) {
    this.o = o;
    this.now = o.now || Date.now;
    this.rand = o.rand || Math.random;
    this.setTimer = o.setTimer || ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = o.clearTimer || ((t) => clearTimeout(t));
    this.timer = null;
    this.poll = null;
    this.lastSpokeAt = 0;
    this.wasAwayMs = 0;
    this.started = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this._schedule();
    // Detect "user came back": poll idle time cheaply.
    this.poll = setInterval(() => this._checkReturn(), 15000);
    if (this.poll.unref) this.poll.unref();
    const cfg = this.o.getConfig();
    if (cfg.enabled && cfg.greetings) this.setTimer(() => this._say("greeting"), 6000);
  }

  stop() {
    this.started = false;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  /** Re-read the config (called when settings change). */
  reschedule() {
    if (!this.started) return;
    this._schedule();
  }

  _gapMs() {
    const cfg = this.o.getConfig();
    const min = Math.max(5, Number(cfg.minMinutes) || 20);
    const max = Math.max(min, Number(cfg.maxMinutes) || 45);
    return (min + (max - min) * this.rand()) * 60 * 1000;
  }

  _schedule(delay) {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => this._onTimer(), delay ?? this._gapMs());
  }

  _onTimer() {
    this.timer = null;
    const cfg = this.o.getConfig();
    if (!cfg.enabled) return this._schedule(); // keep polling the setting
    // Don't talk to an empty room or over a fullscreen app: try again soon.
    if (!this.o.canSpeak() || this.o.idleSeconds() * 1000 > AWAY_MS / 3) return this._schedule(RETRY_MS);
    this._say("remark");
  }

  _checkReturn() {
    const cfg = this.o.getConfig();
    const idleMs = this.o.idleSeconds() * 1000;
    if (idleMs >= AWAY_MS) this.wasAwayMs = Math.max(this.wasAwayMs, idleMs);
    else if (this.wasAwayMs && idleMs < 10000) {
      const away = this.wasAwayMs;
      this.wasAwayMs = 0;
      if (cfg.enabled && cfg.greetings) this._say("welcome_back", { awayMinutes: Math.round(away / 60000) });
    }
  }

  async _say(kind, extra = {}) {
    const cfg = this.o.getConfig();
    if (!cfg.enabled) return;
    if (!this.o.canSpeak()) return;
    if (kind === "remark" && this.now() - this.lastSpokeAt < MIN_GAP_MS) return this._schedule();
    const d = new Date(this.now());
    const ctx = {
      partOfDay: partOfDay(d),
      weekday: d.toLocaleDateString("en-US", { weekday: "long" }),
      time: d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
      ...extra,
    };
    try {
      await this.o.deliver(kind, ctx);
      this.lastSpokeAt = this.now();
    } catch (e) {
      console.warn("[proactive]", kind, "failed:", e && e.message);
    }
    if (kind === "remark" || !this.timer) this._schedule();
  }
}

module.exports = { ProactiveScheduler, buildPrompt, partOfDay };
