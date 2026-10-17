// pet.js — pet window: Pixi + Live2D model, drag/click, idle, TTS + lip sync.
"use strict";

(async function () {
  const statusEl = document.getElementById("status");

  // Stray errors go to the console (visible with --diag-log).
  window.addEventListener("error", (e) => console.error("[pet] error:", e.message || "unknown"));
  window.addEventListener("unhandledrejection", (e) =>
    console.error("[pet] unhandled rejection:", e.reason && e.reason.message ? e.reason.message : e.reason)
  );
  const lipSync = WaifuLipSync.lipSyncEngine;

  // Model: ?model=<folder> under /models/. Everything (model file,
  // expressions, motions) is discovered from the folder — no hardcoded
  // model part names here.
  const params = new URLSearchParams(location.search);
  // Fatal problems (no model, load failure) are shown in the window; the
  // overlay is otherwise hidden so it never covers the pet.
  function showError(msg) {
    statusEl.textContent = msg;
    statusEl.classList.remove("hidden");
  }

  // main.js passes ?model=<folder>. If it is missing, use the bundled default
  // (Tamamo) when present, otherwise the first folder that holds a model.
  let modelFolder = params.get("model");
  if (!modelFolder) {
    try {
      const dirs = await (await fetch("/models/?list=1")).json();
      const ordered = dirs.includes("Tamamo") ? ["Tamamo", ...dirs.filter((d) => d !== "Tamamo")] : dirs;
      for (const d of ordered) {
        try {
          const files = await (await fetch("/models/" + encodeURIComponent(d) + "/?list=1")).json();
          if (files.some((f) => f.endsWith(".model3.json"))) {
            modelFolder = d;
            break;
          }
        } catch {
          /* not a folder */
        }
      }
    } catch {
      /* fall through */
    }
  }
  if (!modelFolder) {
    showError("No Live2D model found — put a model folder inside the models/ folder.");
    return;
  }
  const BASE_DIR = "/models/" + encodeURIComponent(modelFolder) + "/";

  if (!window.Live2DCubismCore) {
    showError("Cubism Core missing — copy vendor/live2dcubismcore.min.js next to the app");
    return;
  }

  // Settings (a redacted copy: no API keys reach this window). Re-read whenever
  // the Settings window saves, so behaviour toggles apply live.
  let cfg = {};
  try {
    cfg = await window.pet.settingsGet();
  } catch (e) {
    console.warn("[pet] could not read settings:", e && e.message);
  }

  // ?tint debug: faint red wash on the page so you can tell "window is truly
  // transparent" (desktop visible through the tint) from "window is a solid
  // box" (black/white/grey, nothing visible behind it).
  if (params.has("tint")) document.body.style.background = "rgba(255, 0, 0, 0.25)";

  const app = new PIXI.Application({
    width: window.innerWidth,
    height: window.innerHeight,
    // Real alpha canvas: transparent WebGL context, cleared to alpha 0 each
    // frame, premultiplied so the compositor blends it over the desktop.
    transparent: true,
    backgroundAlpha: 0,
    clearBeforeRender: true,
    premultipliedAlpha: true,
    antialias: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
  });
  document.getElementById("stage").appendChild(app.view);

  // --- Model ---
  let model;
  // Framing = how the model sits inside the window: zoom (mouse wheel) and an
  // offset (right-drag moves it vertically; Settings can also set X). Offsets
  // are fractions of the window size so they survive window resizing. The Size
  // setting controls the WINDOW size. Framing is remembered per model.
  let zoom = 1;
  let modelOffX = 0;
  let modelOffY = 0;
  // Discover the model3.json file in the model folder (no hardcoded name).
  let modelFile;
  try {
    const entries = await (await fetch(BASE_DIR + "?list=1")).json();
    modelFile = entries.find((f) => f.endsWith(".model3.json"));
    if (!modelFile) throw new Error("no .model3.json in /models/" + modelFolder);
  } catch (e) {
    showError("Failed to find model " + modelFolder + ": " + (e && e.message ? e.message : e));
    return;
  }
  try {
    model = await PIXI.live2d.Live2DModel.from(BASE_DIR + modelFile, { autoInteract: false });
  } catch (e) {
    showError("Failed to load " + modelFolder + ": " + (e && e.message ? e.message : e));
    return;
  }
  app.stage.addChild(model);
  applySavedFraming();
  fitModel();
  statusEl.classList.add("hidden");

  // Bisection flags for the Windows face bug: turn subsystems off one at a
  // time to find which one corrupts the mesh.
  const noMotion = params.has("nomotion");
  // noblink, noexpr, nolipsync, noidle (idle scheduler only).
  const noBlink = params.has("noblink");
  const noExpr = params.has("noexpr");
  const noLipsync = params.has("nolipsync");
  const noIdle = params.has("noidle");

  // Debug hooks (?probe, ?nomask, ?diag, texture dump) live in debug.js.
  if (window.WaifuDebug) WaifuDebug.install({ app, model, params });

  // Live2DModel (a pixi5 Container) has no width/height — the layout size
  // lives on internalModel. Fitting to the wrong size is what made the model
  // disappear or overflow the window on resize.
  function modelSize() {
    const mw = model.internalModel.width || 1;
    const mh = model.internalModel.height || 1;
    return { mw, mh };
  }

  // NOTE: layout uses app.screen (CSS pixels). app.renderer.width/height are
  // DEVICE pixels, which would mis-place the model on 125%/150% display scaling.
  function baseScale() {
    const { mw, mh } = modelSize();
    return Math.min(app.screen.width / mw, app.screen.height / mh) * 0.98 * zoom;
  }

  function fitModel() {
    model.scale.set(baseScale());
    model.anchor.set(0.5, 0.5);
    model.position.set(
      app.screen.width / 2 + modelOffX * app.screen.width,
      app.screen.height / 2 + modelOffY * app.screen.height
    );
  }

  // Let the model sink/rise almost fully out of the window (only 20% of its
  // height must stay visible) so it can be re-grabbed after a big drag.
  function clampOffY(y) {
    const { mh } = modelSize();
    const lim = 0.5 + (mh * baseScale() * 0.6) / 2 / app.screen.height;
    return Math.min(lim, Math.max(-lim, y));
  }

  function applySavedFraming() {
    const fr = cfg.models && cfg.models[modelFolder] && cfg.models[modelFolder].framing;
    const num = (v, d) => (Number.isFinite(v) ? v : d);
    zoom = Math.max(0.2, num(fr && fr.zoom, 1));
    modelOffX = num(fr && fr.x, 0);
    modelOffY = num(fr && fr.y, 0);
  }

  // Remember the framing per model (debounced: the wheel fires many events).
  let saveFramingTimer = null;
  function scheduleSaveFraming() {
    clearTimeout(saveFramingTimer);
    saveFramingTimer = setTimeout(() => window.pet.saveFraming({ zoom, x: modelOffX, y: modelOffY }), 600);
  }

  // Mouse wheel: zoom the model within the window (Size setting controls
  // the window itself).
  window.addEventListener("wheel", (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    // No upper zoom limit — zoom in as far as you want. Lower limit keeps
    // the model from shrinking smaller than the window.
    zoom = Math.max(0.4, zoom * factor);
    modelOffY = clampOffY(modelOffY);
    fitModel();
    scheduleSaveFraming();
  }, { passive: false });

  window.addEventListener("resize", () => {
    app.renderer.resize(window.innerWidth, window.innerHeight);
    modelOffY = clampOffY(modelOffY);
    fitModel();
  });

  // --- Expressions (loose .exp3.json files in the model folder) ---
  // waifu-faces.json (optional): faces to skip, and which face file an emotion uses.
  const facesCfg = await WaifuExpressions.loadFacesConfig(BASE_DIR);
  const exprMap = await WaifuExpressions.loadExpressions(BASE_DIR, facesCfg.skip);
  const exprNames = [...exprMap.keys()];
  const exprCtrl = new WaifuExpressions.ExpressionController(model, {
    fadeInMs: 250,
    holdMs: 5000,
    fadeOutMs: 800,
  });

  // Last emotion asked for (chat tag, idle mood, poke). Drives the tail wag
  // speed even when this model has no matching .exp3.json face, and lapses
  // back to neutral after the same time an expression is held.
  const tailMood = { name: "neutral", until: 0 };
  function playExpression(name) {
    if (name) {
      tailMood.name = String(name).toLowerCase();
      tailMood.until = performance.now() + 250 + 5000 + 800;
    }
    // Exact match first, then close spellings (so [embarrassed] finds a file
    // named "Embarrased"); silently ignored if the model has no such face.
    const mapped = Object.entries(facesCfg.map).find(([k]) => k.toLowerCase() === String(name || "").toLowerCase());
    const key = WaifuExpressions.findClosest(exprNames, mapped ? mapped[1] : name);
    if (key) exprCtrl.apply(exprMap.get(key));
  }

  // --- Motion playback (standard .motion3.json files) ---
  // Motions are discovered from the model folder (Motions/ subfolder or
  // loose files). Idle motions are the ones named Idle_*; everything else
  // is a reaction. Tag -> file mapping is derived from the file names
  // (Curious_Glance.motion3.json -> tag "curious_glance"), so no model-
  // specific names are hardcoded.
  const mm = model.internalModel.motionManager;
  const IDLE_GROUP = "Idle";
  const REACTION_GROUP = "Reaction";
  let motionFiles = [];
  try {
    const entries = await (await fetch(BASE_DIR + "?list=1")).json();
    motionFiles = entries.filter((f) => f.endsWith(".motion3.json"));
    if (motionFiles.length === 0) {
      const sub = await (await fetch(BASE_DIR + "Motions/?list=1")).json();
      motionFiles = sub.filter((f) => f.endsWith(".motion3.json")).map((f) => "Motions/" + f);
    }
  } catch (e) {
    console.warn("[pet] motion discovery failed:", e.message);
  }
  // ?only=<path> restricts the idle list to a single motion file (motion
  // bisection debugging: add motions back one at a time).
  const onlyMotion = params.get("only");
  // Motions declared in model3.json (group "Idle" = idle loop, any other group
  // = reactions) plus loose/Motions/ files named by convention (Idle_*.motion3.json
  // = idle, everything else = reactions, tagged by file name).
  const declared = mm.definitions || {};
  const declaredIdle = [];
  const declaredOther = [];
  for (const [group, defs] of Object.entries(declared)) {
    for (const d of defs || []) {
      if (d && d.File) (/^idle/i.test(group) ? declaredIdle : declaredOther).push(d.File);
    }
  }
  const baseOf = (f) => f.replace(/^.*\//, "").replace(/\.motion3\.json$/, "");
  const isIdleFile = (f) => /^idle_/i.test(baseOf(f));
  const IDLE_MOTIONS = onlyMotion
    ? [onlyMotion]
    : [...new Set([...declaredIdle, ...motionFiles.filter(isIdleFile)])].sort();
  const MOTION_MAP = {};
  for (const f of [...declaredOther, ...motionFiles]) {
    if (isIdleFile(f) || IDLE_MOTIONS.includes(f)) continue;
    MOTION_MAP[baseOf(f).toLowerCase()] = f;
  }
  // Tag aliases: the LLM may emit a tag that differs from the file name.
  const MOTION_ALIASES = { stretch_wave: "stretch" };
  function motionFileFor(tag) {
    if (MOTION_MAP[tag]) return MOTION_MAP[tag];
    const alias = MOTION_ALIASES[tag];
    if (alias && MOTION_MAP[alias]) return MOTION_MAP[alias];
    const near = WaifuExpressions.findClosest(Object.keys(MOTION_MAP), tag);
    return near ? MOTION_MAP[near] : null;
  }

  // Idle loops play in random order, never the same one twice in a row
  // (same rule as Project-Waifu).
  let idleIndex = 0;

  async function playIdle() {
    if (IDLE_MOTIONS.length === 0) return; // model ships no Idle_* motions
    if (IDLE_MOTIONS.length > 1) {
      let i = Math.floor(Math.random() * (IDLE_MOTIONS.length - 1));
      if (i >= idleIndex) i++;
      idleIndex = i;
    } else {
      idleIndex = 0;
    }
    await mm.startMotion(IDLE_GROUP, idleIndex, PIXI.live2d.MotionPriority.IDLE);
  }

  // Idle fidgets wait until a reaction motion is likely finished.
  let reactionUntil = 0;
  async function playReaction(name) {
    const file = motionFileFor(String(name || "").toLowerCase());
    if (!file) return;
    reactionUntil = performance.now() + 5000;
    const idx = mm.definitions[REACTION_GROUP].findIndex((d) => d.File === file);
    if (idx < 0) return;
    await mm.startMotion(REACTION_GROUP, idx, PIXI.live2d.MotionPriority.NORMAL);
  }

  mm.definitions = {
    [IDLE_GROUP]: IDLE_MOTIONS.map((File) => ({ File })),
    [REACTION_GROUP]: Object.values(MOTION_MAP).map((File) => ({ File })),
  };
  mm.motionGroups = { [IDLE_GROUP]: [], [REACTION_GROUP]: [] };

  if (noMotion) {
    console.log("[pet] nomotion: skipping motions, blink, expressions");
  } else {
    try {
      // allSettled: one broken motion file must not stop the rest (and the
      // idle loop) from loading.
      const loads = await Promise.allSettled([
        ...IDLE_MOTIONS.map((_, i) => mm.loadMotion(IDLE_GROUP, i)),
        ...Object.values(MOTION_MAP).map((_, i) => mm.loadMotion(REACTION_GROUP, i)),
      ]);
      const failed = loads.filter((r) => r.status === "rejected");
      if (failed.length) console.warn(`[pet] ${failed.length} motion(s) failed to load:`, failed.map((r) => r.reason && r.reason.message));
      mm.on("motionFinish", () => {
        // After any motion ends, return to the idle loop.
        playIdle();
      });
      if (IDLE_MOTIONS.length > 0) {
        await mm.startMotion(IDLE_GROUP, 0, PIXI.live2d.MotionPriority.IDLE);
      }
    } catch (e) {
      console.warn("[pet] idle motion failed:", e.message);
    }
  }

  // --- Blink (drives the model's own EyeBlink-group parameters directly) ---
  // Ids come from model3.json Groups[EyeBlink]; the Cubism-standard names are
  // only a fallback for models that don't declare the group.
  const idsOr = (ids, fallback) =>
    Array.isArray(ids) && ids.length && ids.every((i) => typeof i === "string") ? ids : fallback;
  const blinkIds = idsOr(mm.eyeBlinkIds, ["ParamEyeLOpen", "ParamEyeROpen"]);
  const mouthIds = idsOr(mm.lipSyncIds, null); // null = Cubism-standard ParamMouthOpenY/Form
  let blinkT0 = 0;
  function startBlink() {
    blinkT0 = performance.now();
  }
  function blinkUpdate(now) {
    const t = now - blinkT0;
    if (t < 0 || t > 300) return;
    let v;
    if (t < 120) v = 1 - t / 120;
    else v = (t - 120) / 180;
    for (const id of blinkIds) model.internalModel.coreModel.setParameterValueById(id, v);
  }

  // --- Procedural tail wag ---
  // Rigs with the 9-segment Param_Angle_Rotation_<n>_TAIL2 chain (Tamamo) get
  // a sine wave per segment, each lagging the previous one, so the wag
  // ripples from base to tip. Set in "beforeModelUpdate" because that fires
  // after motions, expressions and physics have written this frame's values;
  // anything earlier gets overwritten. Speed follows the current mood.
  const TAIL_WAG_RE = /^Param_Angle_Rotation_[1-9]_TAIL2$/;
  const TAIL_WAG_SPEED = {
    happy: 2.0, excited: 2.5, angry: 1.8, embarrassed: 1.6, flirty: 1.5, tipsy: 1.4,
    evil: 1.3, smirk: 1.2, neutral: 1.0, thinking: 0.8, confused: 0.7, surprised: 0.5,
    sad: 0.4, tired: 0.3, crying: 0.3, scared: 0.2,
  };
  function tailWagMultiplier(now) {
    if (now > tailMood.until) return 1.0;
    const n = tailMood.name;
    if (n in TAIL_WAG_SPEED) return TAIL_WAG_SPEED[n];
    // Tolerate spellings like "Embarrased" from expression file names.
    const key = WaifuExpressions.findClosest(Object.keys(TAIL_WAG_SPEED), n);
    return key ? TAIL_WAG_SPEED[key] : 1.0;
  }
  const tailWag = (() => {
    const segs = [];
    const missing = [];
    try {
      const cm = model.internalModel.coreModel;
      for (let n = 1; n <= 9; n++) {
        const id = `Param_Angle_Rotation_${n}_TAIL2`;
        const i = cm.getParameterIndex(id);
        // Cubism returns an index past the real ones for unknown ids.
        if (typeof i === "number" && i >= 0 && i < cm.getParameterCount()) segs.push({ n, i, id });
        else missing.push(id);
      }
    } catch (e) {
      console.warn("[pet] tail wag parameter check failed:", e.message);
      return [];
    }
    if (segs.length === 0) {
      console.log("[pet] tail wag: model has no Param_Angle_Rotation_<1-9>_TAIL2 parameters, wag off");
    } else {
      if (missing.length) console.warn("[pet] tail wag: missing parameters:", missing.join(", "));
      console.log("[pet] tail wag: using", segs.map((s) => s.id).join(", "));
    }
    return segs;
  })();
  // Motion files are the authority: when the playing motion animates the
  // TAIL2 chain itself (Tail_Wag.motion3.json), the procedural wag fades out
  // and the file's own curves are drawn. Files are checked once at load.
  const tailMotionFiles = new Set();
  if (tailWag.length) {
    const allFiles = [...new Set(Object.values(mm.definitions || {}).flat().map((d) => d && d.File).filter(Boolean))];
    await Promise.allSettled(
      allFiles.map(async (f) => {
        const j = await (await fetch(BASE_DIR + f)).json();
        if ((j.Curves || []).some((c) => c && c.Target === "Parameter" && TAIL_WAG_RE.test(c.Id))) tailMotionFiles.add(f);
      })
    );
    if (tailMotionFiles.size) console.log("[pet] tail wag yields to:", [...tailMotionFiles].join(", "));
  }
  function playingMotionDrivesTail() {
    const st = mm.state;
    if (!st || st.currentGroup === undefined || st.currentGroup === null) return false;
    if (typeof mm.isFinished === "function" && mm.isFinished()) return false;
    const def = (mm.definitions[st.currentGroup] || [])[st.currentIndex];
    return Boolean(def && tailMotionFiles.has(def.File));
  }
  if (tailWag.length) {
    let wagOk = true;
    let wagWeight = 1; // 1 = procedural wag, 0 = motion file's tail
    let wagPhase = 0; // integrated, so mood speed changes don't make the tail jump
    let wagSpeed = 3.0;
    let wagLast = performance.now();
    model.internalModel.on("beforeModelUpdate", () => {
      if (!wagOk) return;
      try {
        const now = performance.now();
        const dt = Math.min(0.1, Math.max(0, (now - wagLast) / 1000));
        wagLast = now;
        const target = tailWagMultiplier(now) * 3.0; // radians per second
        wagSpeed += (target - wagSpeed) * Math.min(1, dt * 3); // ease between moods
        wagPhase = (wagPhase + dt * wagSpeed) % (Math.PI * 2000);
        // Ease over ~0.3s so handing the tail to/from a motion never snaps.
        const want = playingMotionDrivesTail() ? 0 : 1;
        wagWeight += (want - wagWeight) * Math.min(1, dt * 8);
        if (wagWeight < 0.001) return;
        const cm = model.internalModel.coreModel;
        for (const s of tailWag) {
          cm.setParameterValueByIndex(s.i, Math.sin(wagPhase - s.n * 0.35) * 15.0, wagWeight);
        }
      } catch (e) {
        wagOk = false;
        console.warn("[pet] tail wag disabled:", e.message);
      }
    });
  }

  // --- Tail amplitude boost ---
  // Tail motions on many rigs are subtle. After the motion has written its
  // parameters each frame, push every tail parameter away from its rest value
  // by pet.tailWagGain (clamped to the parameter's own range). Parameters are
  // found by name ("tail" in the id), so this works for any model.
  const tailParams = (() => {
    const out = [];
    try {
      const cm = model.internalModel.coreModel;
      const raw = cm._model && cm._model.parameters;
      const count = cm.getParameterCount();
      for (let i = 0; i < count; i++) {
        let id = raw && raw.ids ? raw.ids[i] : null;
        if (!id && cm.getParameterId) {
          const h = cm.getParameterId(i);
          id = h && h.getString ? h.getString().s : String(h);
        }
        if (typeof id === "string" && /tail/i.test(id) && !TAIL_WAG_RE.test(id)) {
          out.push({
            i,
            id,
            min: cm.getParameterMinimumValue(i),
            max: cm.getParameterMaximumValue(i),
            def: cm.getParameterDefaultValue(i),
          });
        }
      }
    } catch (e) {
      console.warn("[pet] tail parameter scan failed:", e.message);
    }
    console.log("[pet] tail boost parameters:", out.map((t) => t.id).join(", ") || "(none found)");
    return out;
  })();
  if (tailParams.length) {
    let tailHookOk = true;
    // "beforeModelUpdate" fires AFTER the engine has saved this frame's
    // parameters, so the boost is applied to what is drawn only and never fed
    // back into the next frame (which would compound and pin the tail).
    model.internalModel.on("beforeModelUpdate", () => {
      if (!tailHookOk) return;
      try {
        const gain = Number((cfg.pet || {}).tailWagGain);
        if (!Number.isFinite(gain) || Math.abs(gain - 1) < 0.01) return;
        const cm = model.internalModel.coreModel;
        for (const t of tailParams) {
          const v = cm.getParameterValueByIndex(t.i);
          const boosted = t.def + (v - t.def) * gain;
          cm.setParameterValueByIndex(t.i, Math.min(t.max, Math.max(t.min, boosted)), 1);
        }
      } catch (e) {
        // Never let a cosmetic hook take the render loop (and with it the
        // click-through hit test) down: switch it off and carry on.
        tailHookOk = false;
        console.warn("[pet] tail boost disabled:", e.message);
      }
    });
  }

  // --- Idle scheduler ---
  // While she is idle (not talking, not just clicked/dragged, not mid-reaction)
  // she fidgets with a small motion now and then, glances to the side, and
  // occasionally shows a mild mood. Everything is chosen from what THIS model
  // actually ships; names it doesn't have are simply skipped.
  const FIDGET_PREFERRED = [
    "stretch", "check_nails", "curious_glance", "sigh_tilt", "tilt", "wave", "nod", "tail_wag", "wink", "jiggle_dance",
  ];
  const MILD_MOODS = ["happy", "thinking", "tired", "smirk", "surprised", "confused", "excited"];
  const motionKeys = Object.keys(MOTION_MAP);
  const fidgetPool = (() => {
    const pref = FIDGET_PREFERRED.map((n) => WaifuExpressions.findClosest(motionKeys, n)).filter(Boolean);
    return pref.length ? [...new Set(pref)] : motionKeys;
  })();
  const moodPool = [...new Set(MILD_MOODS.map((n) => WaifuExpressions.findClosest(exprNames, n)).filter(Boolean))];
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  const idle = new WaifuIdle.IdleScheduler({
    expressionNames: moodPool,
    minExprMs: 60000,
    maxExprMs: 150000,
    canIdle: () => {
      const now = performance.now();
      return (cfg.pet || {}).idleBehavior !== false && !isTalking(now) && !drag && now - lastInteractionAt > 8000 && now > reactionUntil;
    },
    onBlink: noBlink ? () => {} : startBlink,
    onExpression: (name) => playExpression(name),
    onFidget: () => fidgetPool.length && playReaction(pick(fidgetPool)),
    onGlance: () => {
      const dir = Math.random() < 0.5 ? -1 : 1;
      glance = { x: dir * (0.25 + Math.random() * 0.45), y: (Math.random() - 0.4) * 0.5, until: performance.now() + 700 + Math.random() * 900 };
    },
  });
  if (!noMotion && !noIdle) idle.start();

  // --- Per-frame ---
  app.ticker.add((ticker) => {
    const now = performance.now();
    updateGaze(now);
    if (!noMotion && !noIdle) idle.tick();
    if (!noMotion && !noExpr) exprCtrl.update(now);
    if (!noMotion && !noBlink) blinkUpdate(now);
    if (!noMotion && !noLipsync) {
      // NOTE: the ticker callback arg is deltaTime (number, 1/60s units),
      // NOT the Ticker instance — reading .deltaMS off it yields undefined,
      // which made lipSync.update(NaN) write NaN into the moc3 param buffer
      // and corrupt the face mesh. Use app.ticker.deltaMS explicitly.
      const ls = lipSync.update(app.ticker.deltaMS / 1000);
      // DEFENSE: lipSync.update() must return finite numbers. A null/NaN here
      // writes garbage into the moc3 parameter buffer and corrupts the face
      // mesh (the "neck skin at face position" bug).
      const openY = Number.isFinite(ls.mouthOpenY) ? ls.mouthOpenY : 0;
      const form = Number.isFinite(ls.mouthForm) ? ls.mouthForm : 0;
      if (mouthIds) {
        for (const id of mouthIds) model.internalModel.coreModel.setParameterValueById(id, openY);
      } else {
        model.internalModel.coreModel.setParameterValueById("ParamMouthOpenY", openY);
      }
      model.internalModel.coreModel.setParameterValueById("ParamMouthForm", form);
    }
  });

  // --- Performance + live settings ---
  // Frame-rate cap (0 = unlimited) and "stop drawing while hidden". Applied at
  // start and whenever the Settings window saves.
  let windowVisible = true;
  function applyPerf() {
    const perf = cfg.perf || {};
    app.ticker.maxFPS = Number.isFinite(perf.maxFps) && perf.maxFps > 0 ? perf.maxFps : 0;
    if (perf.pauseWhenHidden !== false && !windowVisible) app.ticker.stop();
    else app.ticker.start();
  }
  window.pet.onVisible((visible) => {
    windowVisible = !!visible;
    applyPerf();
  });
  window.pet.onSettingsChanged(async () => {
    try {
      cfg = await window.pet.settingsGet();
    } catch {
      return;
    }
    applyPerf();
    applySavedFraming();
    fitModel();
  });
  applyPerf();

  // --- Click-through + drag ---
  // The window is fully transparent, so it ignores the mouse except when the
  // cursor is over the model's actual pixels. setIgnoreMouseEvents(true,
  // {forward:true}) keeps mousemove events arriving so we can hit-test and
  // re-capture. The hit test samples the alpha of the single rendered pixel
  // under the cursor (see below) — pixel-accurate, one tiny GL readback.
  let ignoreMouse = true;
  let drag = null;

  function setIgnore(v) {
    if (v === ignoreMouse) return;
    ignoreMouse = v;
    window.pet.setIgnoreMouse(v);
  }

  // Pixel-accurate hit test. The window is click-through everywhere except
  // where the model actually has visible pixels. We read the alpha of the
  // single framebuffer pixel under the cursor right AFTER Pixi has drawn the
  // frame (so no preserveDrawingBuffer needed), then flip click-through.
  const ALPHA_THRESHOLD = 10; // 0-255; ignore near-invisible anti-aliasing fringe
  const gl = app.renderer.gl;
  const px = new Uint8Array(4);
  let mouse = null; // last cursor position in client (CSS px) coords, or null if outside

  // Cheap pre-filter: skip the GPU readback when the cursor is outside the
  // model's bounding box entirely.
  function inModelBounds(x, y) {
    const { mw, mh } = modelSize();
    if (mw <= 0 || mh <= 0) return false;
    const local = model.toLocal({ x, y });
    const lx = local.x / mw;
    const ly = local.y / mh;
    return lx >= 0 && ly >= 0 && lx <= 1 && ly <= 1;
  }

  function alphaAt(cx, cy) {
    const view = app.renderer.view;
    const r = app.renderer.resolution;
    const x = Math.floor(cx * r);
    const y = view.height - 1 - Math.floor(cy * r); // GL origin is bottom-left
    if (x < 0 || y < 0 || x >= view.width || y >= view.height) return 0;
    // Read from the on-screen buffer explicitly: Live2D's clipping masks render
    // to offscreen framebuffers, and we must never sample one of those.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px[3];
  }

  function overModel(x, y) {
    return inModelBounds(x, y) && alphaAt(x, y) >= ALPHA_THRESHOLD;
  }

  // Runs after Pixi's own render (UTILITY priority < LOW) every frame, so the
  // answer stays correct while she animates under a stationary cursor.
  // A GPU readback stalls the pipeline, so it only runs when the cursor moved
  // (mouseDirty) or every 3rd frame (to follow animation under a still cursor),
  // and never at all while the cursor is outside the model's bounding box.
  let mouseDirty = false;
  let hitFrame = 0;
  app.ticker.add(() => {
    if (drag) return; // never hand the mouse back mid-drag
    if (!mouse) {
      setIgnore(true);
      return;
    }
    if (!mouseDirty && ++hitFrame % 3 !== 0) return;
    mouseDirty = false;
    setIgnore(!overModel(mouse.x, mouse.y));
  }, null, PIXI.UPDATE_PRIORITY.UTILITY);

  // --- Eye / head tracking ---
  // Rules:
  //  * She looks at the mouse only WHILE IT MOVES (and for a moment after),
  //    then returns to looking forward.
  //  * She looks forward while she is talking.
  //  * While idle she occasionally glances to one side.
  //  * Setting pet.lookAtMouse turns mouse-following off entirely.
  // main.js polls the real cursor (so it works anywhere on the desktop, not just
  // over her window) and only sends positions when the cursor actually moved.
  // Gaze is proportional: full deflection when the cursor is ~30% of the screen
  // away. It drives the standard Live2D focus controller, which feeds the
  // model's own eye/angle parameters.
  const FOLLOW_HOLD_MS = 450; // keep looking this long after the last movement
  let lastCursorMoveAt = 0;
  let cursorGaze = null; // normalized {x, y}
  let sawGlobalCursor = false;
  let glance = null; // {x, y, until}
  let lastInteractionAt = performance.now(); // click / drag / chat line

  const clamp1 = (v) => Math.max(-1, Math.min(1, v));
  function gazeFor(cx, cy, rangeX, rangeY) {
    const { mh } = modelSize();
    const eyeX = model.x;
    const eyeY = model.y - mh * model.scale.y * 0.28; // eyes sit above the model's center
    return { x: clamp1((cx - eyeX) / rangeX), y: clamp1(-(cy - eyeY) / rangeY) };
  }

  window.pet.onCursor(({ x, y, dw, dh }) => {
    sawGlobalCursor = true;
    lastCursorMoveAt = performance.now();
    cursorGaze = gazeFor(x, y, Math.max(200, dw * 0.3), Math.max(200, dh * 0.3));
  });

  function updateGaze(now) {
    const fc = model.internalModel.focusController;
    if (!fc) return;
    let gx = 0;
    let gy = 0;
    const talking = isTalking(now);
    const follow =
      (cfg.pet || {}).lookAtMouse !== false && !talking && !drag && cursorGaze && now - lastCursorMoveAt < FOLLOW_HOLD_MS;
    if (follow) {
      gx = cursorGaze.x;
      gy = cursorGaze.y;
    } else if (glance && now < glance.until && !talking) {
      gx = glance.x;
      gy = glance.y;
    }
    fc.focus(gx, gy);
  }

  function poke() {
    lastInteractionAt = performance.now();
    // Click: she smiles (Happy expression, if the model ships one) and may
    // play a random motion.
    playExpression("Happy");
    const motionNames = Object.keys(MOTION_MAP);
    if (Math.random() < 0.5) {
      playReaction(motionNames[Math.floor(Math.random() * motionNames.length)]);
    }
  }

  // Coalesce window moves to one IPC message per animation frame (mouse events
  // can arrive faster than the display refreshes, especially at 1000 Hz).
  let pendingMove = null;
  function queueMove(x, y) {
    if (!pendingMove) {
      requestAnimationFrame(() => {
        const m = pendingMove;
        pendingMove = null;
        if (m) window.pet.moveTo(m.x, m.y);
      });
    }
    pendingMove = { x, y };
  }

  window.addEventListener("mousemove", (e) => {
    if (drag) {
      // Hit-testing is suspended mid-drag so a fast drag can't hand the
      // mouse back to the desktop halfway through.
      if (Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) > 5) drag.moved = true;
      if (drag.moved) {
        if (drag.kind === "model") {
          // Right-drag: move the model vertically within the window.
          // Offset = grab-time offset + cursor delta (NOT the cursor Y —
          // that made the model jump to the cursor's position on release).
          modelOffY = clampOffY(drag.yOffset0 + (e.clientY - drag.y0) / app.screen.height);
          fitModel();
        } else {
          // Left-drag: move the window. Absolute positioning: jump the window
          // so the grab point stays under the cursor (deltas accumulated IPC
          // lag and jittered).
          queueMove(e.screenX - drag.offX, e.screenY - drag.offY);
        }
      }
      return;
    }
    // The per-frame ticker above does the actual hit test (right after the
    // next render); just record where the cursor is and flag it as moved.
    mouse = { x: e.clientX, y: e.clientY };
    mouseDirty = true;
    // Fallback if the main process isn't sending global cursor updates.
    if (!sawGlobalCursor) {
      lastCursorMoveAt = performance.now();
      cursorGaze = gazeFor(e.clientX, e.clientY, window.innerWidth * 0.75, window.innerHeight * 0.75);
    }
  });

  // Cursor left the window: nothing to hit, hand the mouse back to the desktop.
  document.documentElement.addEventListener("mouseleave", () => {
    mouse = null;
    if (!drag) setIgnore(true);
  });

  window.addEventListener("mousedown", (e) => {
    // preventDefault stops Chromium's middle-button auto-scroll from starting
    e.preventDefault();
    if (e.button !== 0 && e.button !== 2) return;
    // Grab offset: the cursor's position WITHIN the window. clientX/Y are
    // relative to the window's top-left for a frameless top-level page
    // (screenX/Y are absolute screen coords — using them here is what made
    // the window teleport to (0,0) on drag). Keeping this point under the
    // cursor means the window top-left = screenX - clientX.
    lastInteractionAt = performance.now();
    drag = {
      kind: e.button === 2 ? "model" : "window",
      x0: e.clientX,
      y0: e.clientY,
      offX: e.clientX,
      offY: e.clientY,
      // Model's vertical offset at grab time (right-drag base).
      yOffset0: modelOffY,
      moved: false,
    };
  });

  window.addEventListener("mouseup", (e) => {
    if (!drag) return;
    const wasDrag = drag.moved;
    const wasModelDrag = drag.kind === "model";
    drag = null;
    lastInteractionAt = performance.now();
    if (wasDrag && wasModelDrag) scheduleSaveFraming();
    if (!wasDrag && e.button === 0) poke();
  });

  // Right-drag repositions the model; suppress the context menu.
  window.addEventListener("contextmenu", (e) => e.preventDefault());

  // Clicking outside the window ends the drag without a poke.
  window.addEventListener("blur", () => {
    drag = null;
  });

  // Start click-through; the first forwarded mousemove over the model
  // re-captures the mouse.
  setIgnore(true);

  // --- Chat lines (from the chat window or proactive remarks) ---
  // { text, speak, emotion?, append? }. `append: false` (a new reply) cuts off
  // whatever she was saying; `append: true` queues another sentence of the same
  // streamed reply behind it.
  window.pet.onChatLine(({ text, emotion, speak, append }) => {
    const now = performance.now();
    lastInteractionAt = now;
    if (!append) clearSpeech();
    const parsed = WaifuTagParser.parseEmotionAndMotionTags(text || "", "neutral", {
      emotions: exprNames,
      motions: Object.keys(MOTION_MAP),
    });
    const emo = emotion || parsed.primaryEmotion;
    if (emo && emo !== "neutral") playExpression(emo);
    if (parsed.primaryMotion !== "none") playReaction(parsed.primaryMotion);
    // Unknown tags (not in this model's vocabulary) must not be spoken either.
    const clean = WaifuTagParser.stripAnyTags(parsed.cleanText || text || "");
    if (speak && clean) enqueueSpeech(clean);
    // Without TTS she still "talks" (looks forward) for roughly the reading time.
    else if (clean) talkingUntil = Math.max(talkingUntil, now + Math.min(6000, 700 + clean.length * 45));
  });

  // --- Speech queue ---
  // Sentences play strictly in order. Each one's TTS request starts as soon as
  // it is queued, so the next sentence is usually ready when the previous ends.
  const speech = { queue: [], playing: false, current: null };
  let talkingUntil = 0;

  function isTalking(now) {
    return speech.playing || speech.queue.length > 0 || now < talkingUntil;
  }

  function stopCurrentSpeech() {
    const cur = speech.current;
    if (!cur) return;
    speech.current = null;
    try {
      cur.audio.pause();
    } catch {}
    cur.finish();
  }

  /** Drop everything queued and cut off what is playing. */
  function clearSpeech() {
    for (const item of speech.queue) item.cancelled = true;
    speech.queue.length = 0;
    talkingUntil = 0;
    stopCurrentSpeech();
  }

  async function fetchSpeech(text) {
    try {
      const { audioBase64, mimeType } = await window.pet.ttsSpeak(text);
      if (!audioBase64) return null;
      const bin = atob(audioBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type: mimeType || "audio/mpeg" });
    } catch (e) {
      console.warn("[tts]", e.message);
      return null;
    }
  }

  function playBlob(blob) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (speech.current && speech.current.audio === audio) speech.current = null;
        URL.revokeObjectURL(url);
        resolve();
      };
      speech.current = { audio, finish };
      lipSync.attachAudioElement(audio);
      audio.onended = finish;
      audio.onerror = finish;
      // Watchdog: if the audio device stalls (unplugged headset, driver hiccup)
      // 'ended' may never fire, which would leave her "talking" forever. Cap
      // playback at the clip length plus a margin.
      let watchdog = setTimeout(finish, 60000);
      audio.onloadedmetadata = () => {
        clearTimeout(watchdog);
        const secs = Number.isFinite(audio.duration) ? audio.duration : 30;
        watchdog = setTimeout(finish, (secs + 2) * 1000);
      };
      audio.addEventListener("ended", () => clearTimeout(watchdog));
      audio.play().catch(finish);
    });
  }

  async function pumpSpeech() {
    if (speech.playing) return;
    speech.playing = true;
    try {
      while (speech.queue.length) {
        const item = speech.queue.shift();
        const blob = await item.blob;
        if (item.cancelled || !blob) continue;
        await playBlob(blob);
      }
    } finally {
      speech.playing = false;
    }
  }

  function enqueueSpeech(text) {
    speech.queue.push({ blob: fetchSpeech(text), cancelled: false });
    pumpSpeech();
  }

  // ?testhook: let automated tests inspect internal state.
  if (window.__waifu) {
    window.__waifu.state = () => ({
      playing: speech.playing,
      queued: speech.queue.length,
      talking: isTalking(performance.now()),
      msSinceCursorMove: Math.round(performance.now() - lastCursorMoveAt),
      hasCursorGaze: !!cursorGaze,
      dragging: !!drag,
    });
  }
})();
