// Idle behavior scheduler for the pet. Pure logic (no DOM) so it can be
// unit-tested in Node. It schedules discrete events only:
//   - blinks (always),
//   - while the pet is idle (canIdle() is true): small fidget motions, brief
//     sideways glances, and occasional mild expression changes.
// The continuous breathing/sway comes from the model's own idle motions
// (looped by the Live2D MotionManager), not from here.
//
// UMD: browser global WaifuIdle + Node module.

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WaifuIdle = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /**
   * @param {object} opts
   * @param {() => void} [opts.onBlink]        called when a blink should start
   * @param {(name: string) => void} [opts.onExpression]  called with an expression name
   * @param {string[]} [opts.expressionNames]  pool of expression names to pick from
   * @param {number} [opts.minBlinkMs=2200]
   * @param {number} [opts.maxBlinkMs=6500]
   * @param {number} [opts.minExprMs=9000]
   * @param {number} [opts.maxExprMs=24000]
   * @param {() => void} [opts.onFidget]       play a small motion
   * @param {() => void} [opts.onGlance]       look briefly to one side
   * @param {() => boolean} [opts.canIdle]     false while talking/interacting
   * @param {number} [opts.minFidgetMs=25000] @param {number} [opts.maxFidgetMs=70000]
   * @param {number} [opts.minGlanceMs=4000]  @param {number} [opts.maxGlanceMs=11000]
   * @param {() => number} [opts.now]          clock, ms
   * @param {() => number} [opts.rand]         0..1 random
   */
  class IdleScheduler {
    constructor(opts = {}) {
      this.onBlink = opts.onBlink || (() => {});
      this.onExpression = opts.onExpression || (() => {});
      this.expressionNames = (opts.expressionNames || []).slice();
      this.minBlinkMs = opts.minBlinkMs ?? 2200;
      this.maxBlinkMs = opts.maxBlinkMs ?? 6500;
      this.minExprMs = opts.minExprMs ?? 9000;
      this.maxExprMs = opts.maxExprMs ?? 24000;
      this.onFidget = opts.onFidget || null;
      this.onGlance = opts.onGlance || null;
      this.canIdle = opts.canIdle || (() => true);
      this.minFidgetMs = opts.minFidgetMs ?? 25000;
      this.maxFidgetMs = opts.maxFidgetMs ?? 70000;
      this.minGlanceMs = opts.minGlanceMs ?? 4000;
      this.maxGlanceMs = opts.maxGlanceMs ?? 11000;
      this._nextFidget = 0;
      this._nextGlance = 0;
      this.now = opts.now || (() => Date.now());
      this.rand = opts.rand || Math.random;
      this.running = false;
      this._nextBlink = 0;
      this._nextExpr = 0;
      this._lastExpr = "";
    }

    start() {
      if (this.running) return;
      this.running = true;
      const t = this.now();
      this._nextBlink = t + this._randBetween(this.minBlinkMs, this.maxBlinkMs);
      this._nextExpr = t + this._randBetween(this.minExprMs, this.maxExprMs);
      this._nextFidget = t + this._randBetween(this.minFidgetMs, this.maxFidgetMs);
      this._nextGlance = t + this._randBetween(this.minGlanceMs, this.maxGlanceMs);
    }

    stop() {
      this.running = false;
    }

    _randBetween(a, b) {
      return a + (b - a) * this.rand();
    }

    /**
     * Call once per frame (or per tick). Fires due events.
     * @returns {boolean} true if anything fired this tick
     */
    tick() {
      if (!this.running) return false;
      const t = this.now();
      let fired = false;

      if (t >= this._nextBlink) {
        this.onBlink();
        fired = true;
        this._nextBlink = t + this._randBetween(this.minBlinkMs, this.maxBlinkMs);
      }

      // Idle-only events: due times keep advancing while busy so she never
      // fires a backlog the moment she goes idle.
      if (t >= this._nextFidget) {
        this._nextFidget = t + this._randBetween(this.minFidgetMs, this.maxFidgetMs);
        if (this.onFidget && this.canIdle()) {
          this.onFidget();
          fired = true;
        }
      }
      if (t >= this._nextGlance) {
        this._nextGlance = t + this._randBetween(this.minGlanceMs, this.maxGlanceMs);
        if (this.onGlance && this.canIdle()) {
          this.onGlance();
          fired = true;
        }
      }

      if (t >= this._nextExpr && this.expressionNames.length > 0) {
        this._nextExpr = t + this._randBetween(this.minExprMs, this.maxExprMs);
        if (this.canIdle()) {
          let name;
          let guard = 0;
          do {
            name = this.expressionNames[Math.floor(this.rand() * this.expressionNames.length)];
            guard++;
          } while (name === this._lastExpr && guard < 8);
          this._lastExpr = name;
          this.onExpression(name);
          fired = true;
        }
      }

      return fired;
    }
  }

  return { IdleScheduler };
});
