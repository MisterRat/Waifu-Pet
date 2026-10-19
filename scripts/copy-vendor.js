// Copies the browser files the windows need out of node_modules into vendor/,
// so the app (and the packaged .exe) loads them from there and does not have to
// carry node_modules. Runs automatically after `npm install`.
//
//   vendor/pixi.min.js, vendor/pixi-unsafe-eval.min.js,
//   vendor/cubism4.min.js                        pet window (committed to git)
//   vendor/vad/                                  conversation mode's voice detection
//                                                (generated here, git-ignored; about 17 MB)
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");

/** Directory of an installed package, or null when it isn't installed. */
function pkgDir(name, from = root) {
  try {
    return path.dirname(require.resolve(name + "/package.json", { paths: [from] }));
  } catch {
    return null;
  }
}

// The onnxruntime-web that vad-web itself resolves (nested or hoisted,
// depending on how npm laid things out). Same search as Project-Waifu.
function ortDirFor(vadDir) {
  if (!vadDir) return null;
  let dir = vadDir;
  for (;;) {
    const candidate = path.join(dir, "node_modules", "onnxruntime-web");
    if (fs.existsSync(path.join(candidate, "dist", "ort-wasm-simd-threaded.wasm"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const vadDir = pkgDir("@ricky0123/vad-web");
const ortDir = ortDirFor(vadDir);

const FILES = [
  ["node_modules/pixi.js/dist/pixi.min.js", "vendor/pixi.min.js"],
  // Lets Pixi run without eval, so the pet page can use a strict Content-Security-Policy.
  ["node_modules/@pixi/unsafe-eval/dist/unsafe-eval.min.js", "vendor/pixi-unsafe-eval.min.js"],
  ["node_modules/pixi-live2d-display/dist/cubism4.min.js", "vendor/cubism4.min.js"],
];
const VAD_FILES = [
  [vadDir, "dist/bundle.min.js", "bundle.min.js"],
  [vadDir, "dist/vad.worklet.bundle.min.js", "vad.worklet.bundle.min.js"],
  [vadDir, "dist/silero_vad_v5.onnx", "silero_vad_v5.onnx"],
  [ortDir, "dist/ort.wasm.min.js", "ort.wasm.min.js"],
  [ortDir, "dist/ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.wasm"],
  [ortDir, "dist/ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.mjs"],
];

let failed = false;
fs.mkdirSync(path.join(root, "vendor", "vad"), { recursive: true });
for (const [from, to] of FILES) {
  const src = path.join(root, from);
  const dst = path.join(root, to);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
    console.log("vendor:", to);
  } else if (!fs.existsSync(dst)) {
    console.error("vendor: missing " + from + " (run npm install)");
    failed = true;
  }
}
for (const [dir, rel, name] of VAD_FILES) {
  const dst = path.join(root, "vendor", "vad", name);
  const src = dir ? path.join(dir, rel) : null;
  if (src && fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
  } else if (!fs.existsSync(dst)) {
    console.error("vendor: missing vad/" + name + " (run npm install)");
    failed = true;
  }
}
if (!failed) console.log("vendor: vad/ (" + VAD_FILES.length + " files)");
if (failed) process.exit(1);
