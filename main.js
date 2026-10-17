// Electron main process: pet window, chat window, settings window, tray.
"use strict";

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, powerMonitor, session, safeStorage, shell, utilityProcess } = require("electron");
const path = require("path");
const fs = require("fs");
const { startStaticServer } = require("./server");
const { SettingsStore } = require("./settings");
const { registerIpc, completeChat, buildSystemPrompt } = require("./ipc");
const { SttService } = require("./stt");
const { FullscreenWatcher } = require("./fullscreen");
const { ProactiveScheduler, buildPrompt } = require("./proactive");
const { listModels, resolveModelName, setModelRoots, getModelRoots } = require("./models");

// App identity. The data folder (settings, logs) is pinned explicitly so it
// never depends on package.json's "name".
app.setName("Waifu Pet");
app.setPath("userData", path.join(app.getPath("appData"), "waifu-pet"));

// Boot trace: append to <userData>/boot-trace.log so a silent exit always
// leaves evidence of how far startup got, even if the console is gone.
// Lives in userData (writable even when installed under Program Files) and
// rolls over at 256 KB so it can never grow without bound.
const TRACE_MAX_BYTES = 256 * 1024;
function trace(msg) {
  const line = new Date().toISOString() + " " + msg + "\n";
  try {
    const dir = app.getPath("userData");
    const file = path.join(dir, "boot-trace.log");
    fs.mkdirSync(dir, { recursive: true });
    try {
      if (fs.statSync(file).size > TRACE_MAX_BYTES) fs.renameSync(file, file + ".old");
    } catch {}
    fs.appendFileSync(file, line);
  } catch {}
  console.log("[main]", msg);
}
trace("main.js loaded pid=" + process.pid + " dir=" + __dirname);

// Windows: make transparent BrowserWindows actually transparent (the
// transparent:true flag alone leaves a black backdrop in some DWM configs).
// (enable-transparent-visuals is a Linux/X11 flag; it does nothing useful on
// Windows, so only pass it there.)
if (process.platform === "linux") {
  app.commandLine.appendSwitch("enable-transparent-visuals");
}

// Never die silently: print uncaught errors to the terminal so `npm start`
// failures are visible instead of an instant, message-less exit.
process.on("uncaughtException", (err) => {
  console.error("[main] uncaught exception:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("[main] unhandled rejection:", err);
});

// --cpu: force software WebGL (SwiftShader) instead of the GPU. Debug/fallback
// for the Windows missing-face bug (run: npm start -- --cpu).
if (process.argv.includes("--cpu")) {
  app.commandLine.appendSwitch("use-gl", "angle");
  app.commandLine.appendSwitch("use-angle", "swiftshader");
  app.commandLine.appendSwitch("enable-unsafe-swiftshader");
  console.log("[main] --cpu: forcing SwiftShader (software WebGL)");
}

const BASE_W = 480;
const BASE_H = 640;
const MIN_SCALE = 0.5;
const MAX_SCALE = 1.5;

let httpServer = null;
let port = 0;
let settings = null;
let petWin = null;
let chatWin = null;
let settingsWin = null;
let tray = null;
let alwaysOnTop = true;
let fullscreenWatcher = null;
let hiddenByFullscreen = false; // pet was hidden automatically (not by the user)
let proactive = null;

const iconPath = path.join(__dirname, "assets", "tray.png");
// 16x16 solid pink PNG, used only if assets/tray.png is missing.
const FALLBACK_TRAY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGklEQVR4nGP4ULHqPyWYYdSAUQNGDRguBgAAufYRLqJOtTkAAAAASUVORK5CYII=";
const isWin = process.platform === "win32";

function clampScale(s) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(s) || 1));
}

function petSize(scale) {
  const s = clampScale(scale);
  return { width: Math.round(BASE_W * s), height: Math.round(BASE_H * s) };
}

/**
 * Where models are looked up, highest priority first:
 *  1. models\ next to the portable .exe (drop-in folder for the single-file build)
 *  2. models\ inside the user-data folder (%APPDATA%\waifu-pet\models)
 *  3. the models bundled with the app (Tamamo) / the project's models\ in dev
 * A model with the same folder name in an earlier location overrides a later one.
 */
function computeModelRoots() {
  const roots = [];
  if (process.env.PORTABLE_EXECUTABLE_DIR) roots.push(path.join(process.env.PORTABLE_EXECUTABLE_DIR, "models"));
  roots.push(path.join(app.getPath("userData"), "models"));
  roots.push(path.join(__dirname, "models"));
  return roots;
}

/** The folder users should drop new models into (created if missing). */
function userModelsFolder() {
  const dir = computeModelRoots()[0];
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.warn("[main] could not create models folder:", e.message);
  }
  return dir;
}

// Folder name of the model currently shown in the pet window.
let loadedModel = null;

// --- Global cursor tracking (for eye/head follow) ---
// The pet window is click-through, so it only gets mouse events while the
// cursor is over it. Polling the OS cursor position lets her follow the mouse
// anywhere on the desktop. Sent relative to the pet window.
let cursorTimer = null;
function startCursorTracking() {
  if (cursorTimer) return;
  let lastX = NaN;
  let lastY = NaN;
  cursorTimer = setInterval(() => {
    if (!petWin || petWin.isDestroyed() || !petWin.isVisible()) return;
    const pt = screen.getCursorScreenPoint();
    // Only report real cursor movement: the pet looks at the mouse while it
    // moves, not at wherever it last stopped.
    if (pt.x === lastX && pt.y === lastY) return;
    lastX = pt.x;
    lastY = pt.y;
    const b = petWin.getBounds();
    const d = screen.getDisplayNearestPoint(pt).bounds;
    petWin.webContents.send("pet:cursor", { x: pt.x - b.x, y: pt.y - b.y, dw: d.width, dh: d.height });
  }, 33);
}

/**
 * Keep a window of size w×h on the desktop without confining it to one
 * monitor: the window's CENTER must stay inside some display's work area (so
 * she can be dragged across monitors, half off an edge, but never lost).
 */
function clampToDesktop(x, y, w, h) {
  const cx = Math.round(x + w / 2);
  const cy = Math.round(y + h / 2);
  const wa = screen.getDisplayNearestPoint({ x: cx, y: cy }).workArea;
  const nx = Math.min(Math.max(cx, wa.x), wa.x + wa.width);
  const ny = Math.min(Math.max(cy, wa.y), wa.y + wa.height);
  return { x: Math.round(nx - w / 2), y: Math.round(ny - h / 2) };
}

/**
 * Move the pet window. Uses setBounds with the FIXED logical size rather than
 * setPosition: on Windows with fractional display scaling (125%/150%),
 * setPosition on a frameless window can make it creep larger while dragging.
 */
function placePet(x, y) {
  if (!petWin || petWin.isDestroyed()) return;
  const { width, height } = petSize(settings.get().pet.scale);
  const p = clampToDesktop(Math.round(x), Math.round(y), width, height);
  petWin.setBounds({ x: p.x, y: p.y, width, height });
}

// Lock a window to our own local origin and deny popups/webviews.
function hardenWindow(win) {
  const origin = `http://127.0.0.1:${port}/`;
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(origin)) e.preventDefault();
  });
  win.webContents.on("will-attach-webview", (e) => e.preventDefault());
}

/** @param {{x:number,y:number}} [pos] initial top-left (defaults to bottom-right of the primary display) */
function createPetWindow(pos) {
  const scale = clampScale(settings.get().pet.scale);
  const { width, height } = petSize(scale);
  const wa = screen.getPrimaryDisplay().workArea;
  const start = pos || {
    x: wa.x + wa.width - width - 24,
    y: wa.y + wa.height - height - 24,
  };

  petWin = new BrowserWindow({
    width,
    height,
    x: start.x,
    y: start.y,
    // --opaque debug: solid window to rule out DWM/X11 transparent compositing.
    transparent: !process.argv.includes("--opaque"),
    backgroundColor: "#00000000", // fully transparent (deskpet does this too)
    frame: false,
    // Windows: a frameless window with WS_THICKFRAME (Electron's default)
    // gets a DWM frame/backdrop that defeats transparency. thickFrame:false
    // removes it (and the shadow/animations, which a pet doesn't need).
    thickFrame: false,
    resizable: false,
    movable: true,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // Show only after first paint so there is no solid-color flash.
    show: false,
    // On Windows a focusable transparent window can keep a black DWM
    // backdrop; deskpet uses focusable:false for the same reason.
    focusable: isWin ? false : true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      // The pet speaks when a chat line arrives over IPC — no user gesture —
      // so audio must be allowed to start without one.
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  hardenWindow(petWin);
  petWin.setAlwaysOnTop(alwaysOnTop, "floating");
  if (!process.argv.includes("--opaque")) petWin.setBackgroundColor("#00000000");
  petWin.once("ready-to-show", () => petWin && petWin.showInactive());
  // Safety net: never leave the pet invisible if ready-to-show doesn't fire.
  const showRef = petWin;
  setTimeout(() => {
    if (showRef && !showRef.isDestroyed() && !showRef.isVisible()) showRef.showInactive();
  }, 4000);
  // Start click-through before the renderer loads so the window never
  // captures the mouse while the model is still loading. The renderer
  // re-captures on the first forwarded mousemove over the model.
  petWin.setIgnoreMouseEvents(true, { forward: true });
  // Debug flags passed through to the renderer (npm start -- --diag, ...).
  const flags = ["nomotion", "diag", "noblink", "noexpr", "nolipsync", "noidle", "tint"].filter(
    (f) => process.argv.includes("--" + f)
  );
  // --wait <ms>: delay before --shot capture (default 6000)
  const waitIdx = process.argv.indexOf("--wait");
  const shotWait = waitIdx > -1 && process.argv[waitIdx + 1] ? parseInt(process.argv[waitIdx + 1], 10) : 6000;
  const onlyIdx = process.argv.indexOf("--only");
  const only = onlyIdx > -1 && process.argv[onlyIdx + 1] ? "only=" + process.argv[onlyIdx + 1] : null;
  // Model: --model <name> overrides the settings default (models/ subfolder).
  const modelIdx = process.argv.indexOf("--model");
  const modelName =
    modelIdx > -1 && process.argv[modelIdx + 1]
      ? process.argv[modelIdx + 1]
      : resolveModelName(settings.get());
  loadedModel = modelName || null;
  const modelQs = modelName ? "model=" + encodeURIComponent(modelName) : null;
  // --probe=<ParamId[:value],...> forces Live2D parameters (rig debugging).
  const probeArg = process.argv.find((a) => a.startsWith("--probe="));
  const probe = probeArg ? "probe=" + encodeURIComponent(probeArg.slice(8)) : null;
  const all = [...flags, only, probe, modelQs].filter(Boolean);
  const qs = all.length ? "?" + all.join("&") : "";
  petWin.loadURL(`http://127.0.0.1:${port}/renderer/index.html${qs}`);
  // --diag-log <path>: also append all renderer console output to a file,
  // so Windows users can capture diag data without a terminal.
  const dlIdx = process.argv.indexOf("--diag-log");
  const diagLog = dlIdx > -1 && process.argv[dlIdx + 1] ? process.argv[dlIdx + 1] : null;
  petWin.webContents.on("console-message", (_e, _level, message) => {
    console.log("[pet renderer]", message);
    if (diagLog) {
      require("fs").appendFileSync(diagLog, new Date().toISOString() + " " + message + "\n");
    }
  });
  // --shot <path>: capture the pet window to a PNG after the model loads.
  // Lets us reproduce/compare the render without a desktop screenshot tool.
  const shotIdx = process.argv.indexOf("--shot");
  if (shotIdx > -1 && process.argv[shotIdx + 1]) {
    const shotPath = process.argv[shotIdx + 1];
    setTimeout(async () => {
      try {
        const img = await petWin.webContents.capturePage();
        require("fs").writeFileSync(shotPath, img.toPNG());
        console.log("[main] captured pet window →", shotPath);
      } catch (e) {
        console.error("[main] capture failed:", e.message);
      }
    }, shotWait);
  }
  petWin.webContents.on("render-process-gone", (_e, details) => {
    console.log("[pet renderer] crashed:", JSON.stringify(details));
  });
  const winRef = petWin;
  // Let the renderer stop drawing while the window is hidden.
  petWin.on("show", () => winRef.webContents.send("pet:visible", true));
  petWin.on("hide", () => winRef.webContents.send("pet:visible", false));
  petWin.on("closed", () => {
    if (petWin === winRef) petWin = null;
  });
}

function createChatWindow() {
  if (chatWin) {
    chatWin.show();
    chatWin.focus();
    return;
  }
  const wa = screen.getPrimaryDisplay().workArea;
  chatWin = new BrowserWindow({
    width: 380,
    height: 540,
    x: Math.max(wa.x, wa.x + wa.width - 400),
    y: Math.max(wa.y, wa.y + wa.height - 560),
    frame: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: alwaysOnTop,
    backgroundColor: "#1a1626",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  hardenWindow(chatWin);
  chatWin.setAlwaysOnTop(alwaysOnTop, "floating");
  chatWin.loadURL(`http://127.0.0.1:${port}/chat/index.html`);
  chatWin.on("closed", () => (chatWin = null));
}

function createSettingsWindow() {
  if (settingsWin) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 760,
    height: 660,
    minWidth: 620,
    minHeight: 480,
    title: "Waifu Pet Settings",
    autoHideMenuBar: true,
    resizable: true,
    backgroundColor: "#1a1626",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  hardenWindow(settingsWin);
  settingsWin.loadURL(`http://127.0.0.1:${port}/chat/settings.html`);
  settingsWin.on("closed", () => (settingsWin = null));
}

// DWM watchdog: after sleep/resume, unlock, or a display-metrics change
// (resolution, DPI, monitor attach) Windows can drop the transparent-visuals
// composition and the window goes solid black. Re-hide + re-show the window
// a moment later to force DWM to rebuild the composition (deskpet's fix).
function installDwmWatchdog() {
  let timer = null;
  const reShow = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (!petWin || petWin.isDestroyed()) return;
      const wasVisible = petWin.isVisible();
      if (!wasVisible) return;
      petWin.hide();
      setTimeout(() => {
        if (petWin && !petWin.isDestroyed()) petWin.showInactive();
      }, 120);
    }, 120);
  };
  powerMonitor.on("resume", reShow);
  powerMonitor.on("unlock-screen", reShow);
  screen.on("display-metrics-changed", reShow);
}

/**
 * Ask the LLM for one unprompted line (greeting / welcome back / remark) and
 * have the pet act it out. Also shows it in the chat log if that window is open.
 */
async function deliverProactiveLine(kind, ctx) {
  const cfg = settings.get();
  if (!cfg.chat.baseUrl) return;
  const messages = [
    { role: "system", content: buildSystemPrompt(cfg, loadedModel) },
    { role: "user", content: buildPrompt(kind, ctx) },
  ];
  const text = await completeChat(cfg, messages, { max_tokens: 120 });
  if (!petWin || petWin.isDestroyed()) return;
  petWin.webContents.send("chat:line", { text, speak: cfg.tts.enabled !== false, proactive: true });
  if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send("chat:assistant-line", { text });
}

function buildTray() {
  let icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    // The pet is click-through, so the tray is the only way to quit — never
    // end up with an invisible tray icon if assets/tray.png is missing.
    console.warn("[main] assets/tray.png missing — using built-in fallback icon");
    icon = nativeImage.createFromDataURL(FALLBACK_TRAY_PNG);
  }
  tray = new Tray(icon);
  tray.setToolTip("Waifu Pet");
  buildTrayMenu();
  tray.on("click", () => raiseVisibleWindows());
  if (process.platform === "win32") {
    tray.on("right-click", () => tray.popUpContextMenu(makeTrayMenu()));
  }
}

function makeTrayMenu() {
  const sizeMenu = Menu.buildFromTemplate(
    [0.5, 0.75, 1.0, 1.25, 1.5].map((s) => ({
      label: s === 1.0 ? "Medium" : s < 1.0 ? `Small (${s})` : `Large (${s})`,
      type: "radio",
      checked: clampScale(settings.get().pet.scale) === s,
      click: () => applyScale(s),
    }))
  );

  const models = listModels();
  const modelMenu = Menu.buildFromTemplate(
    models.map((m) => ({
      label: m.name,
      type: "radio",
      checked: (loadedModel || resolveModelName(settings.get())) === m.name,
      click: () => applyModel(m.name),
    }))
  );

  const menu = Menu.buildFromTemplate([
    { label: "Show / Hide", click: () => togglePet() },
    { label: "Chat", click: () => createChatWindow() },
    { label: "Model", submenu: modelMenu },
    { label: "Size", submenu: sizeMenu },
    {
      label: "Always on Top",
      type: "checkbox",
      checked: alwaysOnTop,
      click: (item) => {
        alwaysOnTop = item.checked;
        applyAlwaysOnTop();
        settings.update({ pet: { alwaysOnTop } });
      },
    },
    { label: "Settings", click: () => createSettingsWindow() },
    { label: "Open Models Folder", click: () => shell.openPath(userModelsFolder()) },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);
  return menu;
}

// Windows: build the menu fresh on each right-click so models added to the
// models/ folder while the app runs show up immediately. Other platforms need
// a static context menu.
function buildTrayMenu() {
  if (process.platform !== "win32" && tray) tray.setContextMenu(makeTrayMenu());
}

/** Apply the Always on Top setting to every window that should obey it. */
function applyAlwaysOnTop() {
  for (const win of [petWin, chatWin]) {
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(alwaysOnTop, "floating");
  }
}

/**
 * Tray left-click: bring whatever is currently visible (the pet and/or the chat
 * window) to the front. If nothing is visible, show the pet instead so the
 * click always does something. Hiding stays on the tray menu's Show/Hide item.
 */
function raiseWindow(win, focus) {
  if (!win || win.isDestroyed() || !win.isVisible()) return false;
  if (win.isMinimized()) win.restore();
  // Windows won't always let a background app raise a window; a brief
  // always-on-top flip reliably does, and the real setting is restored after.
  win.setAlwaysOnTop(true, "screen-saver");
  win.moveTop();
  if (focus) win.focus();
  win.setAlwaysOnTop(alwaysOnTop, "floating");
  return true;
}

function raiseVisibleWindows() {
  const chatRaised = raiseWindow(chatWin, true);
  const petRaised = raiseWindow(petWin, false);
  if (!chatRaised && !petRaised) togglePet();
}

function togglePet() {
  if (!petWin) return;
  hiddenByFullscreen = false; // a manual toggle always wins over auto-hide
  if (petWin.isVisible()) petWin.hide();
  else petWin.showInactive();
}

/** Hide while a fullscreen game/video runs; come back afterwards. */
function applyFullscreenState() {
  if (!petWin || petWin.isDestroyed()) return;
  const want = settings.get().perf.hideOnFullscreen !== false;
  if (want && fullscreenWatcher && fullscreenWatcher.fullscreen) {
    if (petWin.isVisible()) {
      hiddenByFullscreen = true;
      petWin.hide();
    }
  } else if (hiddenByFullscreen) {
    hiddenByFullscreen = false;
    petWin.showInactive();
  }
}

function applyScale(s) {
  const scale = clampScale(s);
  settings.update({ pet: { scale } });
  if (!petWin) return;
  const { width, height } = petSize(scale);
  const [x, y] = petWin.getPosition();
  const [w, h] = petWin.getSize();
  // Keep the model's center fixed; keep the window on the desktop.
  const cx = x + w / 2;
  const cy = y + h / 2;
  const p = clampToDesktop(Math.round(cx - width / 2), Math.round(cy - height / 2), width, height);
  petWin.setBounds({ x: p.x, y: p.y, width, height });
  petWin.webContents.send("pet:scale", scale);
}

// Built-in Whisper. Runs in its own process so turning it off frees the memory.
const stt = new SttService({
  fork: () => utilityProcess.fork(path.join(__dirname, "stt-worker.js"), [], { serviceName: "Waifu Pet Whisper" }),
  cacheDir: path.join(app.getPath("userData"), "whisper-models"),
  onStatus: (status) => {
    for (const win of [settingsWin, chatWin]) {
      if (win && !win.isDestroyed()) win.webContents.send("stt:status", status);
    }
  },
});

/** Called after the Settings window saves: apply anything that takes effect live. */
function onSettingsChanged() {
  const cfg = settings.get();
  const want = resolveModelName(cfg);
  if (want && want !== loadedModel) applyModel(want);
  alwaysOnTop = cfg.pet.alwaysOnTop !== false;
  applyAlwaysOnTop();
  buildTrayMenu();
  // Fullscreen watcher on/off, proactive timing, and let the pet window
  // re-read its own behaviour/performance/framing settings.
  if (fullscreenWatcher) {
    if (cfg.perf.hideOnFullscreen !== false) fullscreenWatcher.start();
    else fullscreenWatcher.stop();
    applyFullscreenState();
  }
  if (proactive) proactive.reschedule();
  stt.apply(cfg.stt);
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send("pet:settings-changed");
}

// Switch the pet model: persist the choice and reload the pet window with
// the new ?model= query param (the renderer discovers everything else from
// the model folder).
function applyModel(name) {
  if (!listModels().some((m) => m.name === name)) return;
  settings.update({ pet: { model: name } });
  if (petWin) {
    const [px, py] = petWin.getPosition();
    petWin.close();
    petWin = null;
    // Created at the old spot; shown by ready-to-show after first paint.
    createPetWindow({ x: px, y: py });
  }
  buildTrayMenu();
}

function registerWindowIpc() {
  // Window-control messages are only honoured from the window they belong to.
  const fromWin = (win, e) => Boolean(win && !win.isDestroyed() && e.sender === win.webContents);
  const fromPet = (e) => fromWin(petWin, e);
  const fromChat = (e) => fromWin(chatWin, e);
  const fromSettingsWin = (e) => fromWin(settingsWin, e);
  const finite = (...n) => n.every((v) => Number.isFinite(v));

  ipcMain.on("window:move-by", (e, dx, dy) => {
    if (!fromPet(e) || !finite(dx, dy)) return;
    const [x, y] = petWin.getPosition();
    placePet(x + dx, y + dy);
  });

  ipcMain.on("window:move-to", (e, x, y) => {
    if (!fromPet(e) || !finite(x, y)) return;
    placePet(x, y);
  });

  // The pet window reports how the user framed the model (mouse-wheel zoom /
  // right-drag); remember it per model.
  ipcMain.on("pet:save-framing", (e, f) => {
    if (!fromPet(e) || !loadedModel || !f) return;
    if (!finite(f.zoom, f.x, f.y)) return;
    const framing = {
      // Same zoom range as the pet window (renderer/pet.js ZOOM_MIN/ZOOM_MAX).
      zoom: Math.min(20, Math.max(0.4, f.zoom)),
      x: Math.min(1, Math.max(-1, f.x)),
      y: Math.min(1, Math.max(-1, f.y)),
    };
    settings.update({ models: { [loadedModel]: { framing } } });
  });

  ipcMain.on("window:set-ignore-mouse", (e, ignore) => {
    if (!fromPet(e)) return;
    // forward:true keeps mousemove events flowing to the renderer so it can
    // hit-test and re-capture the mouse when the cursor reaches the model.
    petWin.setIgnoreMouseEvents(!!ignore, { forward: true });
  });

  // Size is set from the Settings window (Save applies it straight away).
  ipcMain.on("window:set-scale", (e, s) => {
    if (fromSettingsWin(e) || fromPet(e)) applyScale(s);
  });

  ipcMain.on("window:quit", (e) => {
    if (fromPet(e)) app.quit();
  });

  ipcMain.on("window:open-chat", (e) => {
    if (fromPet(e)) createChatWindow();
  });
  ipcMain.on("window:open-settings", (e) => {
    if (fromPet(e) || fromChat(e)) createSettingsWindow();
  });

  ipcMain.on("chat:close", (e) => {
    if (fromChat(e)) chatWin.close();
  });
  ipcMain.on("settings:close", (e) => {
    if (fromSettingsWin(e)) settingsWin.close();
  });

  // Chat window asks main to push a line to the pet's speech bubble.
  ipcMain.on("chat:push-line", (e, payload) => {
    if (fromChat(e) && petWin && !petWin.isDestroyed()) petWin.webContents.send("chat:line", payload);
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.log(
    "[main] Another Waifu Pet instance is already running (single-instance lock in %APPDATA%/waifu-pet).\n" +
      "[main] Quit the existing pet from its tray icon, then start this one."
  );
  app.quit();
} else {
  app.on("second-instance", () => {
    if (petWin) petWin.showInactive();
  });

  app.whenReady().then(async () => {
    console.log("[main] app ready, starting static server…");
    setModelRoots(computeModelRoots());
    // Encrypt API keys at rest with the OS keystore (DPAPI on Windows).
    settings = new SettingsStore(app.getPath("userData"), {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (s) => safeStorage.encryptString(s),
      decrypt: (b) => safeStorage.decryptString(b),
    });
    // Deny every permission except microphone capture for the chat window
    // (voice input). Nothing else ever needs camera/location/etc.
    const micAllowed = (wc, permission, details) =>
      permission === "media" &&
      !!chatWin &&
      !chatWin.isDestroyed() &&
      wc === chatWin.webContents &&
      (!details || !details.mediaTypes || details.mediaTypes.every((t) => t === "audio"));
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => cb(micAllowed(wc, permission, details)));
    session.defaultSession.setPermissionCheckHandler((wc, permission, _origin, details) => micAllowed(wc, permission, details));
    alwaysOnTop = settings.get().pet.alwaysOnTop !== false;

    httpServer = await startStaticServer(__dirname, { modelRoots: getModelRoots });
    port = httpServer.port;

    registerIpc(settings, {
      getLoadedModel: () => loadedModel,
      getOrigin: () => (port ? `http://127.0.0.1:${port}` : ""),
      onSettingsChanged,
      stt,
    });
    stt.apply(settings.get().stt); // loads Whisper at startup only if voice input is enabled
    registerWindowIpc();
    buildTray();
    startCursorTracking();
    installDwmWatchdog();

    // Fullscreen detection (Windows) + unprompted behaviour.
    fullscreenWatcher = new FullscreenWatcher();
    fullscreenWatcher.on("change", applyFullscreenState);
    if (settings.get().perf.hideOnFullscreen !== false) fullscreenWatcher.start();
    proactive = new ProactiveScheduler({
      getConfig: () => settings.get().proactive,
      canSpeak: () => !!petWin && !petWin.isDestroyed() && petWin.isVisible() && !(fullscreenWatcher && fullscreenWatcher.fullscreen),
      idleSeconds: () => powerMonitor.getSystemIdleTime(),
      deliver: deliverProactiveLine,
    });
    proactive.start();

    // Delayed window creation: on Windows the DWM transparent-visuals
    // compositor can still be initializing right after app ready; creating
    // the transparent window immediately is what leaves a black backdrop.
    // deskpet (and other working transparent pets) wait ~50ms.
    setTimeout(() => {
      try {
        createPetWindow();
        console.log("[main] pet window created");
      } catch (err) {
        console.error("[main] pet window creation failed:", err);
      }
    }, 50);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createPetWindow();
    });
  }).catch((err) => {
    console.error("[main] startup failed:", err);
  });

  app.on("window-all-closed", () => {
    // Closing the last window (the pet) ends the app; the tray icon goes with it.
    app.quit();
  });

  // Electron doesn't wait for an async before-quit handler, so shut things down
  // synchronously; the local server's sockets close with the process.
  app.on("before-quit", () => {
    if (cursorTimer) clearInterval(cursorTimer);
    if (proactive) proactive.stop();
    if (fullscreenWatcher) fullscreenWatcher.stop();
    stt.unload(true);
    if (httpServer) {
      try {
        httpServer.close();
      } catch {}
    }
  });
}
