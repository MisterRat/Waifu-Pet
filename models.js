// Model discovery: each subfolder of a models root is one Live2D model. Roots
// are searched in order and the first folder with a given name wins, so a
// user's models folder can override a bundled model. (Dev: ./models/. The
// packaged app also searches next to the .exe and in the user-data folder.)
// A model folder is valid if it contains a *.model3.json file.
// Expressions are loose *.exp3.json files in the model folder; motions are
// standard *.motion3.json files in the model folder (or a Motions/ subfolder).
// No model-specific names are hardcoded anywhere — everything is discovered.
"use strict";

const fs = require("fs");
const path = require("path");

let roots = [path.join(__dirname, "models")];

/** Set the folders that are searched for models (highest priority first). */
function setModelRoots(list) {
  roots = (list || []).filter(Boolean).map((r) => path.resolve(r));
}

function getModelRoots() {
  return roots.slice();
}

/** Absolute path of a model's folder, or null. `name` must be a plain folder name. */
function modelDir(name) {
  if (!name || name !== path.basename(String(name)) || name === "." || name === "..") return null;
  for (const r of roots) {
    const d = path.join(r, name);
    try {
      if (fs.statSync(d).isDirectory()) return d;
    } catch {
      /* try the next root */
    }
  }
  return null;
}

/** A model folder's waifu-faces.json, cleaned; empty lists when it has none or it is invalid. */
function readFacesConfig(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "waifu-faces.json"), "utf8").replace(/^\uFEFF/, ""));
    const ok = (v) => typeof v === "string" && v.length > 0 && v.length <= 80;
    return {
      skip: (Array.isArray(raw.skip) ? raw.skip : []).filter(ok),
      map: Object.fromEntries(
        Object.entries(raw.map && typeof raw.map === "object" ? raw.map : {}).filter(([k, v]) => ok(k) && ok(v))
      ),
    };
  } catch {
    return { skip: [], map: {} };
  }
}

/**
 * List available models.
 * @returns {Array<{name: string, modelFile: string, expressions: string[], motions: string[], faces: {skip: string[], map: Object<string, string>}}>}
 *   modelFile/expressions/motions are folder-relative paths (POSIX separators).
 */
function listModels() {
  const out = [];
  const seen = new Set();
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || seen.has(e.name)) continue;
      const dir = path.join(root, e.name);
      let files;
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue;
      }
      const modelFiles = files.filter((f) => f.endsWith(".model3.json"));
      if (modelFiles.length === 0) continue;
      seen.add(e.name);
      // waifu-faces.json (optional): { "skip": ["Crying"], "map": { "crying": "Sad" } }
      const faces = readFacesConfig(dir);
      const skip = new Set(faces.skip.map((n) => n.toLowerCase()));
      const expressions = files.filter(
        (f) => f.endsWith(".exp3.json") && !skip.has(f.replace(/\.exp3\.json$/i, "").toLowerCase())
      );
      // Motions: prefer a Motions/ subfolder, fall back to loose files.
      let motions = [];
      const motionDir = path.join(dir, "Motions");
      if (fs.existsSync(motionDir) && fs.statSync(motionDir).isDirectory()) {
        motions = fs
          .readdirSync(motionDir)
          .filter((f) => f.endsWith(".motion3.json"))
          .map((f) => "Motions/" + f);
      } else {
        motions = files.filter((f) => f.endsWith(".motion3.json"));
      }
      out.push({
        name: e.name,
        modelFile: modelFiles.sort()[0],
        expressions: expressions.sort(),
        motions: motions.sort(),
        faces,
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve the model folder name from settings, falling back to the first
 * available model. Returns null if no models exist at all.
 */
function resolveModelName(settings) {
  const models = listModels();
  if (models.length === 0) return null;
  const wanted = settings && settings.pet && settings.pet.model;
  return models.some((m) => m.name === wanted) ? wanted : models[0].name;
}

/** Read width/height from a PNG header, or null if it isn't a PNG. */
function pngSize(file) {
  try {
    const fd = fs.openSync(file, "r");
    const b = Buffer.alloc(24);
    fs.readSync(fd, b, 0, 24, 0);
    fs.closeSync(fd);
    if (b.toString("latin1", 1, 4) !== "PNG") return null;
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  } catch {
    return null;
  }
}

/**
 * Health check for one model folder, shown in Settings. Model-agnostic: it only
 * checks what the model itself declares plus the Cubism-standard parameter
 * names the app relies on for gaze, blinking and lip sync.
 * @param {string} name model folder name
 * @returns {{name: string, checks: Array<{level: "ok"|"warn"|"error", text: string}>}}
 */
function inspectModel(name) {
  const checks = [];
  const add = (level, text) => checks.push({ level, text });
  const m = listModels().find((x) => x.name === name);
  if (!m) {
    add("error", "Model folder not found (it needs a .model3.json file).");
    return { name, checks };
  }
  const dir = modelDir(name);
  const inside = (rel) => {
    const abs = path.resolve(dir, rel);
    return abs === dir || abs.startsWith(dir + path.sep) ? abs : null;
  };
  const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(dir, rel), "utf8").replace(/^\uFEFF/, ""));

  let settings;
  try {
    settings = readJson(m.modelFile);
  } catch (e) {
    add("error", `${m.modelFile} is not valid JSON: ${e.message}`);
    return { name, checks };
  }
  const refs = settings.FileReferences || {};
  if (settings.Version !== 3) add("error", "Not a Cubism 3/4/5 model (Version must be 3).");

  // Required and optional files.
  const need = (label, rel, required) => {
    if (!rel) {
      if (required) add("error", `${label} is not declared in ${m.modelFile}.`);
      return;
    }
    const abs = inside(rel);
    if (!abs) add("error", `${label} points outside the model folder: ${rel}`);
    else if (!fs.existsSync(abs)) add(required ? "error" : "warn", `${label} file is missing: ${rel}`);
  };
  need("Moc", refs.Moc, true);
  need("Physics", refs.Physics, false);
  need("Pose", refs.Pose, false);
  const textures = Array.isArray(refs.Textures) ? refs.Textures : [];
  if (textures.length === 0) add("error", "No textures are declared.");
  let missingTex = 0;
  let bigTex = null;
  for (const t of textures) {
    const abs = inside(t);
    if (!abs || !fs.existsSync(abs)) {
      missingTex++;
      continue;
    }
    const sz = pngSize(abs);
    if (sz && Math.max(sz.w, sz.h) > 4096 && (!bigTex || sz.w * sz.h > bigTex.w * bigTex.h)) bigTex = sz;
  }
  if (missingTex) add("error", `${missingTex} texture file(s) are missing.`);
  else if (textures.length) add("ok", `${textures.length} texture(s) found.`);
  if (bigTex) {
    add(
      "warn",
      `A texture is ${bigTex.w}×${bigTex.h}. Very large textures use a lot of GPU memory and can fail to render on some GPUs; ` +
        "4096×4096 or smaller is safest."
    );
  }

  // Parameters the app drives. Use the model's own display info when present.
  let paramIds = null;
  if (refs.DisplayInfo && inside(refs.DisplayInfo) && fs.existsSync(inside(refs.DisplayInfo))) {
    try {
      paramIds = new Set((readJson(refs.DisplayInfo).Parameters || []).map((p) => p.Id));
    } catch {
      add("warn", `${refs.DisplayInfo} could not be read, so parameters were not checked.`);
    }
  } else {
    add("warn", "No display-info (.cdi3.json) file, so the model's parameters can't be checked.");
  }
  if (paramIds) {
    const groups = settings.Groups || [];
    const groupIds = (g) => (groups.find((x) => x.Name === g) || {}).Ids || [];
    const has = (ids) => ids.length > 0 && ids.every((i) => paramIds.has(i));
    const blink = groupIds("EyeBlink");
    const mouth = groupIds("LipSync");
    has(blink.length ? blink : ["ParamEyeLOpen", "ParamEyeROpen"])
      ? add("ok", "Blinking will work.")
      : add("warn", "Eye-open parameters not found: she won't blink.");
    has(mouth.length ? mouth : ["ParamMouthOpenY"])
      ? add("ok", "Lip sync will work.")
      : add("warn", "Mouth-open parameter not found: no lip sync while speaking.");
    has(["ParamEyeBallX", "ParamEyeBallY"])
      ? add("ok", "Eyes can follow the mouse.")
      : add("warn", "Eyeball parameters not found: her eyes can't follow the mouse.");
    has(["ParamAngleX", "ParamAngleY"])
      ? add("ok", "Head can turn toward the mouse.")
      : add("warn", "Head-angle parameters not found: her head won't turn.");
  }

  // Expressions and motions.
  let badFiles = 0;
  for (const f of [...m.expressions, ...m.motions]) {
    try {
      readJson(f);
    } catch {
      badFiles++;
      add("error", `${f} is not valid JSON.`);
    }
  }
  if (!badFiles) {
    m.expressions.length
      ? add("ok", `${m.expressions.length} expression(s).`)
      : add("warn", "No expressions (.exp3.json): emotion tags won't change her face.");
    const idle = m.motions.filter((f) => /(^|\/)idle/i.test(f)).length;
    const react = m.motions.filter((f) => !/(^|\/)idle/i.test(f)).length;
    idle
      ? add("ok", `${idle} idle motion(s) (named Idle_*.motion3.json).`)
      : add("warn", "No idle motions (Idle_*.motion3.json): she will only blink while idle.");
    react
      ? add("ok", `${react} reaction motion(s).`)
      : add("warn", "No reaction motions: motion tags and fidgets won't do anything.");
  }
  return { name, checks };
}

module.exports = { listModels, resolveModelName, inspectModel, setModelRoots, getModelRoots, modelDir };
