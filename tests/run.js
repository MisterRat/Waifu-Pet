// Node smoke tests for pure renderer modules.
"use strict";

const assert = require("assert");
const path = require("path");

const R = (f) => require(path.join(__dirname, "..", "renderer", f));

let passed = 0;
const pending = [];
// Supports sync and async tests; async failures fail the run (non-zero exit).
function test(name, fn) {
  const r = fn();
  if (r && typeof r.then === "function") {
    pending.push(
      r.then(
        () => {
          passed++;
          console.log("ok -", name);
        },
        (e) => {
          console.error("FAIL -", name, "\n", e);
          process.exitCode = 1;
        }
      )
    );
    return;
  }
  passed++;
  console.log("ok -", name);
}

// --- tagParser ---
const { parseEmotionAndMotionTags } = R("tagParser.js");

test("tagParser: extracts emotions and cleans text", () => {
  const r = parseEmotionAndMotionTags("Hello there! [happy] I [excited] love this!");
  assert.deepStrictEqual(r.emotions, ["happy", "excited"]);
  assert.strictEqual(r.primaryEmotion, "happy");
  assert.strictEqual(r.cleanText, "Hello there! I love this!");
});

test("tagParser: aliases and fallback", () => {
  const r = parseEmotionAndMotionTags("nothing here", "sad");
  assert.strictEqual(r.primaryEmotion, "sad");
  const b = parseEmotionAndMotionTags("[blush] oops");
  assert.strictEqual(b.primaryEmotion, "embarrassed");
});

test("tagParser: motions", () => {
  const r = parseEmotionAndMotionTags("[nod] [wave] hi");
  assert.deepStrictEqual(r.motions, ["nod", "wave"]);
  assert.strictEqual(r.primaryMotion, "nod");
});

test("tagParser: model vocabulary adds its own tags", () => {
  const vocab = { emotions: ["shy"], motions: ["spin"] };
  const r = parseEmotionAndMotionTags("Oh [shy] hi [spin] there", "neutral", vocab);
  assert.deepStrictEqual(r.emotions, ["shy"]);
  assert.deepStrictEqual(r.motions, ["spin"]);
  assert.strictEqual(r.cleanText, "Oh hi there");
  // Without the vocab an unknown tag is left alone.
  assert.strictEqual(parseEmotionAndMotionTags("Oh [shy] hi").cleanText, "Oh [shy] hi");
});

// --- generic name matching ---
const { findClosest } = R("expressions.js");

test("findClosest: exact, typo and miss", () => {
  const names = ["Happy", "Embarrased", "Disgudted", "Sad"];
  assert.strictEqual(findClosest(names, "happy"), "Happy");
  assert.strictEqual(findClosest(names, "embarrassed"), "Embarrased");
  assert.strictEqual(findClosest(names, "disgusted"), "Disgudted");
  assert.strictEqual(findClosest(names, "angry"), null);
  assert.strictEqual(findClosest(names, "sa"), null);
});

// --- idle ---
const { IdleScheduler } = R("idle.js");

test("idle: fires blink and expression on schedule", () => {
  let now = 0;
  const blinks = [];
  const exprs = [];
  const s = new IdleScheduler({
    now: () => now,
    rand: () => 0.5,
    minBlinkMs: 100,
    maxBlinkMs: 200,
    minExprMs: 50,
    maxExprMs: 100,
    expressionNames: ["happy", "sad"],
    onBlink: () => blinks.push(now),
    onExpression: (n) => exprs.push(n),
  });
  s.start();
  for (let i = 0; i < 200; i++) {
    now += 10;
    s.tick();
  }
  assert.ok(blinks.length >= 1, "blink fired");
  assert.ok(exprs.length >= 1, "expression fired");
  assert.ok(exprs.every((e) => ["happy", "sad"].includes(e)));
});

test("idle: stop prevents firing", () => {
  let now = 0;
  const s = new IdleScheduler({
    now: () => now,
    rand: () => 0.5,
    minBlinkMs: 10,
    maxBlinkMs: 20,
    expressionNames: ["happy"],
    onBlink: () => assert.fail("should not blink"),
    onExpression: () => assert.fail("should not expr"),
  });
  s.start();
  s.stop();
  now += 1000;
  s.tick();
});

// --- expressions: controller envelope math (mock model) ---
const { ExpressionController } = R("expressions.js");

test("expressions: envelope ramps up, holds, fades to baseline", () => {
  const values = {};
  const model = {
    internalModel: {
      coreModel: {
        getParameterValueById: (id) => values[id] ?? 0,
        setParameterValueById: (id, v) => (values[id] = v),
      },
    },
  };
  // fake clock
  let t = 1000;
  const realNow = performance.now;
  performance.now = () => t;
  try {
    const c = new ExpressionController(model, { fadeInMs: 100, holdMs: 100, fadeOutMs: 100 });
    c.apply({ name: "Happy", params: [{ id: "Param3", value: 1, blend: "Set" }] });
    t = 1050;
    c.update();
    assert.ok(values.Param3 > 0 && values.Param3 < 1, "fading in: " + values.Param3);
    t = 1150;
    c.update();
    assert.strictEqual(values.Param3, 1, "holding at 1");
    t = 1250;
    c.update();
    assert.ok(values.Param3 > 0 && values.Param3 < 1, "fading out: " + values.Param3);
    t = 1300;
    c.update();
    assert.strictEqual(values.Param3, 0, "back to baseline");
    assert.strictEqual(c.active, null);
  } finally {
    performance.now = realNow;
  }
});

test("expressions: Add blend adds to baseline", () => {
  const values = { Param3: 0.5 };
  const model = {
    internalModel: {
      coreModel: {
        getParameterValueById: (id) => values[id] ?? 0,
        setParameterValueById: (id, v) => (values[id] = v),
      },
    },
  };
  let t = 0;
  const realNow = performance.now;
  performance.now = () => t;
  try {
    const c = new ExpressionController(model, { fadeInMs: 10, holdMs: 10, fadeOutMs: 10 });
    c.apply({ name: "X", params: [{ id: "Param3", value: 1, blend: "Add" }] });
    t = 20; // end of hold (fadeIn 10 + hold 10)
    c.update();
    assert.strictEqual(values.Param3, 1.5, "Add blend: 0.5 + 1.0");
  } finally {
    performance.now = realNow;
  }
});

// --- settings: per-model overrides ---
const { modelOverride } = require("../settings.js");

test("modelOverride: returns non-empty override", () => {
  const models = { ModelA: { systemPrompt: "You are a test persona.", voice: "af" } };
  assert.strictEqual(modelOverride(models, "ModelA", "systemPrompt"), "You are a test persona.");
  assert.strictEqual(modelOverride(models, "ModelA", "voice"), "af");
});

test("modelOverride: blank/missing falls back to empty", () => {
  const models = { ModelA: { systemPrompt: "   ", voice: "af" } };
  assert.strictEqual(modelOverride(models, "ModelA", "systemPrompt"), "");
  assert.strictEqual(modelOverride(models, "Nobody", "voice"), "");
  assert.strictEqual(modelOverride(undefined, "ModelA", "voice"), "");
});

// --- extractContent (root-level module) ---
const { extractContent, extractSseContent } = require("../extractContent.js");

test("extractContent: standard chat completions", () => {
  assert.strictEqual(
    extractContent({ choices: [{ message: { content: "hi there" } }] }),
    "hi there"
  );
});

test("extractContent: content parts array", () => {
  assert.strictEqual(
    extractContent({
      choices: [{ message: { content: [{ type: "text", text: "a" }, "b"] } }],
    }),
    "ab"
  );
});

test("extractContent: empty / non-object", () => {
  assert.strictEqual(extractContent({}), "");
  assert.strictEqual(extractContent(null), "");
});

test("extractSseContent: reassembles delta stream", () => {
  const raw =
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n' +
    "data: [DONE]\n\n";
  assert.strictEqual(extractSseContent(raw), "Hello");
});

test("extractSseContent: no data lines -> empty", () => {
  assert.strictEqual(extractSseContent("just text"), "");
});

test("idle: fidgets and glances only fire while idle", () => {
  let t = 0;
  let idle = false;
  const fired = { fidget: 0, glance: 0, expr: 0 };
  const sched = new IdleScheduler({
    now: () => t,
    rand: () => 0,
    expressionNames: ["a"],
    minExprMs: 100, maxExprMs: 100,
    minFidgetMs: 100, maxFidgetMs: 100,
    minGlanceMs: 100, maxGlanceMs: 100,
    canIdle: () => idle,
    onFidget: () => fired.fidget++,
    onGlance: () => fired.glance++,
    onExpression: () => fired.expr++,
  });
  sched.start();
  t = 150; sched.tick(); // busy: nothing fires
  assert.deepStrictEqual(fired, { fidget: 0, glance: 0, expr: 0 });
  idle = true;
  t = 160; sched.tick(); // no backlog fired the instant she goes idle
  assert.deepStrictEqual(fired, { fidget: 0, glance: 0, expr: 0 });
  t = 300; sched.tick();
  assert.deepStrictEqual(fired, { fidget: 1, glance: 1, expr: 1 });
});

// --- model inspection ---
const { listModels, inspectModel } = require("../models");

test("inspectModel: unknown folder is an error, bundled models have none", () => {
  assert.strictEqual(inspectModel("no-such-model").checks[0].level, "error");
  for (const m of listModels()) {
    const bad = inspectModel(m.name).checks.filter((c) => c.level === "error");
    assert.deepStrictEqual(bad, [], m.name + " should have no errors");
  }
});

// --- waifu-faces.json: skip a face file, map an emotion to another face ---
test("waifu-faces.json: skipped faces are never listed or loaded, mapped emotions stay tags", () => {
  const fs = require("fs");
  const os = require("os");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "faces-"));
  const dir = path.join(tmp, "Model");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "m.model3.json"), "{}");
  for (const n of ["Sad", "Crying", "Happy"]) fs.writeFileSync(path.join(dir, n + ".exp3.json"), "{}");
  fs.writeFileSync(path.join(dir, "waifu-faces.json"), JSON.stringify({ skip: ["crying"], map: { crying: "Sad" }, junk: 1 }));
  const models = require("../models");
  const before = models.getModelRoots();
  try {
    models.setModelRoots([tmp]);
    const m = models.listModels().find((x) => x.name === "Model");
    assert.deepStrictEqual(m.expressions, ["Happy.exp3.json", "Sad.exp3.json"]);
    assert.deepStrictEqual(m.faces, { skip: ["crying"], map: { crying: "Sad" } });
  } finally {
    models.setModelRoots(before);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const { cleanFacesConfig } = R("expressions.js");
  assert.deepStrictEqual(cleanFacesConfig({ skip: ["A", 3, ""], map: { x: "B", y: 4 } }), { skip: ["A"], map: { x: "B" } });
  assert.deepStrictEqual(cleanFacesConfig(null), { skip: [], map: {} });
});

// --- multiple model roots (packaged app: next to the .exe, user data, bundled) ---
const fsx = require("fs");
const osx = require("os");
const pathx = require("path");
const { setModelRoots, getModelRoots, modelDir } = require("../models");
const { startStaticServer } = require("../server");

function fakeModel(root, name, extra = {}) {
  const dir = pathx.join(root, name);
  fsx.mkdirSync(dir, { recursive: true });
  fsx.writeFileSync(pathx.join(dir, name + ".model3.json"), JSON.stringify({ Version: 3, FileReferences: { Moc: "x.moc3", Textures: [] } }));
  for (const [f, body] of Object.entries(extra)) fsx.writeFileSync(pathx.join(dir, f), body);
}

test("models: roots are searched in order and the first folder name wins", () => {
  const tmp = fsx.mkdtempSync(pathx.join(osx.tmpdir(), "roots-"));
  const user = pathx.join(tmp, "user");
  const bundled = pathx.join(tmp, "bundled");
  fakeModel(bundled, "Shared", { "A.exp3.json": "{}" });
  fakeModel(bundled, "OnlyBundled");
  fakeModel(user, "Shared", { "B.exp3.json": "{}" }); // overrides the bundled one
  fakeModel(user, "OnlyUser");
  const saved = getModelRoots();
  setModelRoots([user, pathx.join(tmp, "does-not-exist"), bundled]);
  try {
    const list = listModels();
    assert.deepStrictEqual(list.map((m) => m.name), ["OnlyBundled", "OnlyUser", "Shared"]);
    assert.deepStrictEqual(list.find((m) => m.name === "Shared").expressions, ["B.exp3.json"]);
    assert.strictEqual(modelDir("OnlyBundled"), pathx.join(bundled, "OnlyBundled"));
    assert.strictEqual(modelDir("../user"), null, "path tricks are refused");
    assert.strictEqual(modelDir("nope"), null);
  } finally {
    setModelRoots(saved);
  }
});

test("server: /models/ is served from the model roots, nothing else leaks", async () => {
  const tmp = fsx.mkdtempSync(pathx.join(osx.tmpdir(), "srv-"));
  const userRoot = pathx.join(tmp, "user");
  const bundledRoot = pathx.join(tmp, "bundled");
  fakeModel(userRoot, "Mine", { "Hello.txt": "hi from user" });
  fakeModel(bundledRoot, "Theirs", { "Hello.txt": "hi from bundled" });
  fsx.writeFileSync(pathx.join(tmp, "secret.txt"), "top secret");
  const srv = await startStaticServer(pathx.join(__dirname, ".."), { modelRoots: () => [userRoot, bundledRoot] });
  const get = async (p) => {
    const r = await fetch(`http://127.0.0.1:${srv.port}${p}`);
    return [r.status, await r.text()];
  };
  try {
    assert.deepStrictEqual(await get("/models/Mine/Hello.txt"), [200, "hi from user"]);
    assert.deepStrictEqual(await get("/models/Theirs/Hello.txt"), [200, "hi from bundled"]);
    assert.deepStrictEqual(JSON.parse((await get("/models/?list=1"))[1]), ["Mine", "Theirs"]);
    assert.strictEqual((await get("/models/Mine/../../secret.txt"))[0] >= 400, true);
    assert.strictEqual((await get("/models/Mine/%2e%2e/%2e%2e/secret.txt"))[0] >= 400, true);
    assert.strictEqual((await get("/models/Missing/x"))[0], 404);
    assert.strictEqual((await get("/main.js"))[0], 403);
  } finally {
    await srv.close();
  }
});

// --- streaming parser ---
const { createSseParser } = require("../extractContent");

test("createSseParser: reassembles deltas split across chunks", () => {
  const out = [];
  const p = createSseParser((t) => out.push(t));
  const body = 'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n';
  for (let i = 0; i < body.length; i += 7) p.push(body.slice(i, i + 7)); // awkward chunk size
  p.end();
  assert.strictEqual(out.join(""), "Hello");
});

test("createSseParser: ignores junk and role-only deltas", () => {
  const out = [];
  const p = createSseParser((t) => out.push(t));
  p.push(': keepalive\ndata: not json\ndata: {"choices":[{"delta":{"role":"assistant"}}]}\n');
  p.end();
  assert.deepStrictEqual(out, []);
});

// --- proactive scheduler ---
const { ProactiveScheduler, buildPrompt, partOfDay } = require("../proactive");

test("proactive: partOfDay boundaries", () => {
  assert.strictEqual(partOfDay(new Date(2026, 0, 1, 4)), "night");
  assert.strictEqual(partOfDay(new Date(2026, 0, 1, 5)), "morning");
  assert.strictEqual(partOfDay(new Date(2026, 0, 1, 12)), "afternoon");
  assert.strictEqual(partOfDay(new Date(2026, 0, 1, 17)), "evening");
  assert.strictEqual(partOfDay(new Date(2026, 0, 1, 22)), "night");
});

test("proactive: prompts mention the context", () => {
  const ctx = { partOfDay: "evening", weekday: "Friday", time: "7:00 PM", awayMinutes: 45 };
  assert.ok(buildPrompt("greeting", ctx).includes("evening"));
  assert.ok(buildPrompt("welcome_back", ctx).includes("45"));
  assert.ok(buildPrompt("remark", ctx).includes("Friday"));
});

function makeScheduler(over = {}) {
  const timers = [];
  const delivered = [];
  const state = { enabled: true, canSpeak: true, idle: 0, now: 1e9 };
  const sched = new ProactiveScheduler({
    getConfig: () => ({ enabled: state.enabled, greetings: true, minMinutes: 20, maxMinutes: 20 }),
    canSpeak: () => state.canSpeak,
    idleSeconds: () => state.idle,
    deliver: async (kind) => void delivered.push(kind),
    now: () => state.now,
    rand: () => 0,
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      t.cleared = true;
    },
    ...over,
  });
  return { sched, timers, delivered, state };
}

test("proactive: greets once at start, then schedules a remark", async () => {
  const { sched, timers, delivered } = makeScheduler();
  sched.start();
  sched.stop(); // stops the poll interval; timers are fake
  const greeting = timers.find((t) => t.ms === 6000);
  assert.ok(greeting, "a startup greeting is scheduled");
  await greeting.fn();
  assert.deepStrictEqual(delivered, ["greeting"]);
  assert.ok(timers.some((t) => t.ms === 20 * 60 * 1000), "remark timer uses the configured gap");
});

test("proactive: stays quiet when disabled, hidden, or the user is away", async () => {
  for (const mutate of [(s) => (s.enabled = false), (s) => (s.canSpeak = false), (s) => (s.idle = 3600)]) {
    const { sched, timers, delivered, state } = makeScheduler();
    sched.start();
    sched.stop();
    mutate(state);
    const remark = timers.find((t) => t.ms === 20 * 60 * 1000);
    await remark.fn();
    assert.deepStrictEqual(delivered, []);
  }
});


// ---- speech text + built-in Whisper service ----
const { stripTags } = require("../speechText");
const { SttService, normModel } = require("../stt");
const TP = R("tagParser.js");
const { EventEmitter } = require("events");

test("speechText: unknown [tags] are never spoken, real brackets survive", () => {
  assert.strictEqual(stripTags("Hello [giggle] there! [soft smile] I like [1] things [hap"), "Hello there! I like [1] things");
  assert.strictEqual(TP.stripAnyTags("Hi [pout] you [happy] ok"), "Hi you ok");
});

test("stt: normModel falls back to base for unknown / legacy names", () => {
  assert.strictEqual(normModel("whisper-1"), "base");
  assert.strictEqual(normModel("small"), "small");
});

function fakeWorker() {
  const w = new EventEmitter();
  w.sent = [];
  w.killed = false;
  w.postMessage = (m) => {
    w.sent.push(m);
    if (m.type === "transcribe") setImmediate(() => w.emit("message", { type: "result", id: m.id, text: " hello world " }));
  };
  w.kill = () => (w.killed = true);
  return w;
}

test("stt: loads on enable, transcribes, and unloads (kills the process) on disable", async () => {
  const workers = [];
  const statuses = [];
  const svc = new SttService({ fork: () => workers.push(fakeWorker()) && workers[workers.length - 1], cacheDir: "x", onStatus: (s) => statuses.push(s.state) });

  svc.apply({ enabled: false });
  assert.strictEqual(workers.length, 0, "nothing is loaded while disabled");

  svc.apply({ enabled: true, model: "base" });
  assert.strictEqual(workers.length, 1);
  assert.deepStrictEqual(workers[0].sent[0], { type: "load", repo: "Xenova/whisper-base", cacheDir: "x" });
  await assert.rejects(svc.transcribe(new Float32Array(16000), "auto"), /still loading/);

  workers[0].emit("message", { type: "progress", percent: 40 });
  assert.strictEqual(svc.status.state, "downloading");
  workers[0].emit("message", { type: "ready" });
  assert.strictEqual(svc.status.state, "ready");

  svc.apply({ enabled: true, model: "base" });
  assert.strictEqual(workers.length, 1, "same settings do not reload");

  assert.strictEqual(await svc.transcribe(new Float32Array(16000), "auto"), " hello world ");

  svc.apply({ enabled: true, model: "small" });
  assert.strictEqual(workers.length, 2, "changing the model reloads");
  assert.ok(workers[0].killed);

  svc.apply({ enabled: false });
  assert.ok(workers[1].killed, "disable kills the worker so memory is freed");
  assert.strictEqual(svc.status.state, "off");
  await assert.rejects(svc.transcribe(new Float32Array(16000)), /turned off/);
});

test("stt: a crashed worker is reported, and a worker error stops loading", () => {
  const w = fakeWorker();
  const svc = new SttService({ fork: () => w, cacheDir: "x" });
  svc.apply({ enabled: true, model: "tiny" });
  w.emit("message", { type: "error", message: "download failed" });
  assert.strictEqual(svc.status.state, "error");
  assert.match(svc.status.message, /download failed/);
});

Promise.all(pending).then(() => console.log(`\n${passed} tests passed`));
