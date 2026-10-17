// Expression loading + application for any Live2D model.
//
// The model's model3.json has NO "Expressions" section (the .exp3.json files are
// VTube Studio-style loose files), so we load them ourselves and drive the
// parameters directly with a fade-in -> hold -> fade-out envelope.
//
// UMD: works as a browser <script> (window.WaifuExpressions) and in Node (tests).

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WaifuExpressions = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /**
   * Fetch every .exp3.json in a directory and parse them.
   * @param {string} baseUrl e.g. "http://127.0.0.1:PORT/models/<ModelFolder>/"
   * @returns {Promise<Map<string, {name: string, params: Array<{id: string, value: number, blend: string}>}>>}
   */
  /**
   * The model's optional waifu-faces.json: { "skip": ["Crying"], "map": { "crying": "Sad" } }.
   * skip = face files never used; map = emotion -> face file to use for it. Lets the owner tune
   * faces without editing the rigger's .exp3.json files. Returns empty lists when absent.
   * @param {string} baseUrl
   * @returns {Promise<{skip: string[], map: Object<string, string>}>}
   */
  async function loadFacesConfig(baseUrl) {
    const empty = { skip: [], map: {} };
    try {
      const res = await fetch(baseUrl.replace(/\/?$/, "/") + "waifu-faces.json");
      if (!res.ok) return empty;
      return cleanFacesConfig(await res.json());
    } catch {
      return empty;
    }
  }

  /** Keep only well-formed entries of a parsed waifu-faces.json. */
  function cleanFacesConfig(raw) {
    const ok = (v) => typeof v === "string" && v.length > 0 && v.length <= 80;
    const r = raw && typeof raw === "object" ? raw : {};
    return {
      skip: (Array.isArray(r.skip) ? r.skip : []).filter(ok),
      map: Object.fromEntries(
        Object.entries(r.map && typeof r.map === "object" ? r.map : {}).filter(([k, v]) => ok(k) && ok(v))
      ),
    };
  }

  /**
   * @param {string} baseUrl
   * @param {string[]} [skip] face names (file name without .exp3.json) never to load
   */
  async function loadExpressions(baseUrl, skip = []) {
    const out = new Map();
    const skipped = new Set(skip.map((n) => String(n).toLowerCase()));
    let entries = [];
    try {
      const res = await fetch(baseUrl.replace(/\/?$/, "/") + "?list=1");
      if (res.ok) entries = await res.json();
    } catch {
      return out;
    }
    for (const file of entries) {
      if (!/\.exp3\.json$/i.test(file)) continue;
      const name = file.replace(/\.exp3\.json$/i, "");
      if (skipped.has(name.toLowerCase())) continue;
      try {
        const res = await fetch(baseUrl.replace(/\/?$/, "/") + file);
        const data = await res.json();
        const params = (data.Parameters || [])
          .filter((p) => p && typeof p.Id === "string")
          .map((p) => ({
            id: p.Id,
            value: Number(p.Value) || 0,
            blend: p.Blend === "Add" ? "Add" : p.Blend === "Multiply" ? "Multiply" : "Set",
          }));
      out.set(name, { name, params });
      } catch (e) {
        console.warn("[expressions] failed to load", file, e.message);
      }
    }
    return out;
  }

  /** Levenshtein edit distance (small strings only). */
  function editDistance(a, b) {
    const m = a.length;
    const n = b.length;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[n];
  }

  /**
   * Find the name in `names` that best matches `query`: exact (case-insensitive)
   * first, then a close spelling (so a tag like [embarrassed] still finds a
   * file called "Embarrased.exp3.json"). Returns the original name or null.
   * @param {Iterable<string>} names
   * @param {string} query
   * @param {number} [maxDist=2]
   */
  function findClosest(names, query, maxDist = 2) {
    const q = String(query || "").toLowerCase().trim();
    if (!q) return null;
    const list = [...names];
    for (const n of list) if (String(n).toLowerCase() === q) return n;
    if (q.length < 5) return null; // too short to fuzzy-match safely
    let best = null;
    let bestD = Infinity;
    for (const n of list) {
      const l = String(n).toLowerCase();
      const d = editDistance(l, q);
      const limit = Math.min(maxDist, Math.floor(Math.max(l.length, q.length) / 4));
      if (d <= limit && d < bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  }

  /**
   * One face's value for a parameter, given what the motion produced this frame
   * (`cur`) and the face's weight (0 = not shown, 1 = fully shown). Same rules as
   * the Live2D library's expression manager: Set moves toward the value, Add adds
   * a share of it, Multiply scales by a share of it.
   */
  function blendParam(cur, value, blend, w) {
    if (blend === "Add") return cur + value * w;
    if (blend === "Multiply") return cur * (1 + (value - 1) * w);
    return cur + (value - cur) * w;
  }

  const smoothstep = (t) => t * t * (3 - 2 * t);

  /**
   * Controller that applies expressions to a Live2D model with a
   * fade-in -> hold -> fade-out envelope.
   *
   * Faces are layers drawn on top of whatever the motion produced this frame,
   * never a snapshot of the model's values. update() must be called at a point in
   * the frame after the engine has saved its parameters (the pet calls it from
   * Live2D's focus step), so nothing a face writes is carried into the next
   * frame: when a face fades out she is exactly back to her motion and defaults,
   * and a new face starting mid-fade can never record leftovers as "neutral".
   * A new face cross-fades with the previous one over fadeInMs.
   *
   * @param {object} model pixi-live2d-display Live2DModel
   * @param {object} [opts]
   * @param {number} [opts.fadeInMs=250]
   * @param {number} [opts.holdMs=4000]
   * @param {number} [opts.fadeOutMs=600]
   */
  class ExpressionController {
    constructor(model, opts = {}) {
      this.model = model;
      this.fadeInMs = opts.fadeInMs ?? 250;
      this.holdMs = opts.holdMs ?? 4000;
      this.fadeOutMs = opts.fadeOutMs ?? 600;
      // Newest last: { name, params, t0, holdMs, out: null | { t, w, ms } }
      this.layers = [];
    }

    /** Read a parameter's current value from the model (0 if unknown). */
    getParam(id) {
      try {
        const v = this.model.internalModel.coreModel.getParameterValueById(id);
        return typeof v === "number" && isFinite(v) ? v : 0;
      } catch {
        return 0;
      }
    }

    setParam(id, v) {
      try {
        this.model.internalModel.coreModel.setParameterValueById(id, v);
      } catch {
        /* parameter not in model — ignore */
      }
    }

    /** A layer's weight at `now` (0..1), or -1 once it has fully faded out. */
    weightOf(layer, now) {
      if (layer.out) {
        const k = layer.out.ms > 0 ? (now - layer.out.t) / layer.out.ms : 1;
        return k >= 1 ? -1 : layer.out.w * (1 - k);
      }
      const e = now - layer.t0;
      if (e < this.fadeInMs) return smoothstep(Math.max(0, e / this.fadeInMs));
      if (e < this.fadeInMs + layer.holdMs) return 1;
      const k = (e - this.fadeInMs - layer.holdMs) / this.fadeOutMs;
      return k >= 1 ? -1 : smoothstep(1 - k);
    }

    /** Start fading every current layer out from wherever it is now. */
    fadeOutAll(ms, now) {
      for (const l of this.layers) {
        if (l.out) continue;
        const w = this.weightOf(l, now);
        l.out = { t: now, w: Math.max(0, w), ms };
      }
    }

    /**
     * Apply an expression definition. The previous face cross-fades out.
     * @param {{name: string, params: Array<{id: string, value: number, blend: string}>}} def
     * @param {number} [holdMs] override hold duration
     */
    apply(def, holdMs) {
      if (!def || !def.params || def.params.length === 0) return;
      const now = performance.now();
      this.fadeOutAll(this.fadeInMs, now);
      this.layers.push({
        name: def.name,
        params: def.params.map((p) => ({ id: p.id, value: p.value, blend: p.blend })),
        t0: now,
        holdMs: holdMs ?? this.holdMs,
        out: null,
      });
    }

    /** Fade everything back to her motion and defaults. */
    clear() {
      this.fadeOutAll(this.fadeOutMs, performance.now());
    }

    get active() {
      return this.layers.length ? this.layers[this.layers.length - 1] : null;
    }

    get activeName() {
      const a = this.active;
      return a && !a.out ? a.name : "neutral";
    }

    /**
     * Call once per frame, after motions have been applied and saved. Returns
     * true while any face is showing.
     */
    update(now = performance.now()) {
      if (!this.layers.length) return false;
      const live = [];
      for (const l of this.layers) {
        const w = this.weightOf(l, now);
        if (w < 0) continue;
        live.push(l);
        if (w <= 0) continue;
        for (const p of l.params) this.setParam(p.id, blendParam(this.getParam(p.id), p.value, p.blend, w));
      }
      this.layers = live;
      return live.length > 0;
    }
  }

  /**
   * Blink curve: 1 = eyes as the face/motion has them, 0 = shut. Closes over
   * 120 ms, opens over 180 ms (same curve as Project-Waifu). It scales eye-open
   * rather than setting it, so a narrowed or closed-eye face stays that way.
   */
  function blinkFactor(sinceMs) {
    if (!(sinceMs >= 0) || sinceMs > 300) return 1;
    return sinceMs < 120 ? 1 - sinceMs / 120 : (sinceMs - 120) / 180;
  }

  /**
   * Lip sync's share of the mouth. It takes the mouth only while she is speaking
   * (eased in and out, held briefly across the gap between sentences), so faces
   * keep their own mouth shape the rest of the time. While speaking, mouth-open is
   * the larger of the face's and the voice's, and the face's mouth form is blended
   * with the voice's, as in Project-Waifu.
   */
  class MouthMixer {
    constructor(opts = {}) {
      this.holdMs = opts.holdMs ?? 250;
      this.weight = 0;
      this.lastSpeakingAt = -Infinity;
    }

    /**
     * @param {{mouthOpenY: number, mouthForm: number, isSpeaking: boolean}} ls lip sync's output
     * @param {number} now ms
     * @param {number} dtSec
     */
    step(ls, now, dtSec) {
      if (ls && ls.isSpeaking) this.lastSpeakingAt = now;
      const want = now - this.lastSpeakingAt <= this.holdMs ? 1 : 0;
      const k = Math.min(1, Math.max(0, dtSec) * 12);
      this.weight += (want - this.weight) * k;
      if (want === 0 && this.weight < 0.002) this.weight = 0;
      return this.weight;
    }

    /** Mouth-open value to write, given the face/motion's own value `cur`. */
    openY(cur, voice) {
      const v = Number.isFinite(voice) ? voice : 0;
      return cur + (Math.max(cur, v) - cur) * this.weight;
    }

    /** Mouth-form value to write, given the face/motion's own value `cur`. */
    form(cur, voice) {
      const v = Number.isFinite(voice) ? voice : 0;
      const spoken = Math.max(-1, Math.min(1, cur * 0.4 + v * 0.85));
      return cur + (spoken - cur) * this.weight;
    }
  }

  return {
    loadExpressions,
    loadFacesConfig,
    cleanFacesConfig,
    ExpressionController,
    blendParam,
    blinkFactor,
    MouthMixer,
    findClosest,
    editDistance,
  };
});
