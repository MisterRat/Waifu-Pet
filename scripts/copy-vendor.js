// Copies the two browser bundles the pet window needs out of node_modules into
// vendor/, so the app (and the packaged .exe) loads them from there and does
// not have to carry node_modules. Runs automatically after `npm install`.
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const FILES = [
  ["node_modules/pixi.js/dist/pixi.min.js", "vendor/pixi.min.js"],
  ["node_modules/pixi-live2d-display/dist/cubism4.min.js", "vendor/cubism4.min.js"],
];

let failed = false;
fs.mkdirSync(path.join(root, "vendor"), { recursive: true });
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
if (failed) process.exit(1);
