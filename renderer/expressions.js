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
   * Controller that applies expressions to a Live2D model with a
   * fade-in -> hold -> fade-out envelope.
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
      this.active = null; // { name, params: [{id, base, target}], t0, holdMs }
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

    /**
     * Apply an expression definition.
     * @param {{name: string, params: Array<{id: string, value: number, blend: string}>}} def
     * @param {number} [holdMs] override hold duration
     */
    apply(def, holdMs) {
      if (!def || !def.params || def.params.length === 0) return;
      const params = def.params.map((p) => {
        const base = this.getParam(p.id);
        const target = p.blend === "Add" ? base + p.value : p.blend === "Multiply" ? base * p.value : p.value;
        return { id: p.id, base, target };
      });
      this.active = {
        name: def.name,
        params,
        t0: performance.now(),
        holdMs: holdMs ?? this.holdMs,
      };
    }

    /** Fade everything back to baseline. */
    clear() {
      if (!this.active) return;
      this.active = {
        name: "neutral",
        params: this.active.params.map((p) => ({
          id: p.id,
          base: p.base,
          target: p.base,
        })),
        t0: performance.now(),
        holdMs: 0,
      };
    }

    get activeName() {
      return this.active ? this.active.name : "neutral";
    }

    /** Call once per frame. Returns true while an envelope is in flight. */
    update(now = performance.now()) {
      const a = this.active;
      if (!a) return false;
      const elapsed = now - a.t0;
      const fadeIn = this.fadeInMs;
      const hold = a.holdMs;
      const fadeOut = this.fadeOutMs;

      let t;
      if (elapsed < fadeIn) t = elapsed / fadeIn;
      else if (elapsed < fadeIn + hold) t = 1;
      else if (elapsed < fadeIn + hold + fadeOut)
        t = 1 - (elapsed - fadeIn - hold) / fadeOut;
      else {
        for (const p of a.params) this.setParam(p.id, p.base);
        this.active = null;
        return false;
      }

      const s = t * t * (3 - 2 * t); // smoothstep
      for (const p of a.params) {
        this.setParam(p.id, p.base + (p.target - p.base) * s);
      }
      return true;
    }
  }

  return { loadExpressions, loadFacesConfig, cleanFacesConfig, ExpressionController, findClosest, editDistance };
});
