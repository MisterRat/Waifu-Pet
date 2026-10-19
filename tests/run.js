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
const { ExpressionController, blendParam, blinkFactor, MouthMixer } = R("expressions.js");

// Mock of the Live2D engine's frame: each frame starts from the saved (motion)
// values, the face step writes on top, and nothing it wrote is kept.
function mockFrameModel(saved) {
  let values = { ...saved };
  return {
    saved,
    get values() {
      return values;
    },
    frame(fn) {
      values = { ...saved };
      fn();
      return values;
    },
    model: {
      internalModel: {
        coreModel: {
          getParameterValueById: (id) => values[id] ?? 0,
          setParameterValueById: (id, v) => (values[id] = v),
        },
      },
    },
  };
}

function withClock(fn) {
  const realNow = performance.now;
  const clock = { t: 1000 };
  performance.now = () => clock.t;
  try {
    fn(clock);
  } finally {
    performance.now = realNow;
  }
}

test("expressions: envelope ramps up, holds, fades to baseline", () => {
  withClock((clock) => {
    const m = mockFrameModel({ Param3: 0 });
    const c = new ExpressionController(m.model, { fadeInMs: 100, holdMs: 100, fadeOutMs: 100 });
    c.apply({ name: "Happy", params: [{ id: "Param3", value: 1, blend: "Set" }] });
    clock.t = 1050;
    let v = m.frame(() => c.update()).Param3;
    assert.ok(v > 0 && v < 1, "fading in: " + v);
    clock.t = 1150;
    assert.strictEqual(m.frame(() => c.update()).Param3, 1, "holding at 1");
    clock.t = 1250;
    v = m.frame(() => c.update()).Param3;
    assert.ok(v > 0 && v < 1, "fading out: " + v);
    clock.t = 1300;
    assert.strictEqual(m.frame(() => c.update()).Param3, 0, "back to baseline");
    assert.strictEqual(c.active, null);
    assert.strictEqual(c.activeName, "neutral");
  });
});

test("expressions: Add and Multiply apply on top of this frame's value", () => {
  withClock((clock) => {
    const m = mockFrameModel({ A: 0.5, M: 0.8 });
    const c = new ExpressionController(m.model, { fadeInMs: 10, holdMs: 10, fadeOutMs: 10 });
    c.apply({ name: "X", params: [{ id: "A", value: 1, blend: "Add" }, { id: "M", value: 0.5, blend: "Multiply" }] });
    clock.t = 1020;
    const v = m.frame(() => c.update());
    assert.strictEqual(v.A, 1.5, "Add: 0.5 + 1.0");
    assert.strictEqual(v.M, 0.4, "Multiply: 0.8 x 0.5");
  });
  assert.ok(Math.abs(blendParam(0.2, 1, "Set", 0.5) - 0.6) < 1e-9);
  assert.strictEqual(blendParam(2, 0.5, "Multiply", 0), 2, "weight 0 leaves the value alone");
});

test("expressions: a new face mid-fade leaves no leftovers behind", () => {
  // The review's bug: a face that started while another was fading recorded the
  // leftovers as neutral, so values it didn't set stayed stuck.
  withClock((clock) => {
    const m = mockFrameModel({ Brow: 0, Cheek: 0 });
    const c = new ExpressionController(m.model, { fadeInMs: 100, holdMs: 100, fadeOutMs: 100 });
    c.apply({ name: "Angry", params: [{ id: "Brow", value: 1, blend: "Set" }] });
    clock.t = 1250; // Angry is half faded out
    m.frame(() => c.update());
    c.apply({ name: "Blush", params: [{ id: "Cheek", value: 1, blend: "Set" }] });
    clock.t = 1400; // Blush fully in, Angry long gone
    let v = m.frame(() => c.update());
    assert.strictEqual(v.Brow, 0, "Brow is back to its default, not stuck");
    assert.strictEqual(v.Cheek, 1);
    clock.t = 1600; // Blush faded out too
    v = m.frame(() => c.update());
    assert.deepStrictEqual(v, { Brow: 0, Cheek: 0 }, "she ends exactly at her defaults");
    assert.strictEqual(c.layers.length, 0);
  });
});

test("expressions: the previous face cross-fades out instead of snapping", () => {
  withClock((clock) => {
    const m = mockFrameModel({ Brow: 0 });
    const c = new ExpressionController(m.model, { fadeInMs: 100, holdMs: 1000, fadeOutMs: 100 });
    c.apply({ name: "Angry", params: [{ id: "Brow", value: 1, blend: "Set" }] });
    clock.t = 1200;
    c.apply({ name: "Calm", params: [{ id: "Mouth", value: 1, blend: "Set" }] });
    clock.t = 1250;
    const v = m.frame(() => c.update()).Brow;
    assert.ok(v > 0 && v < 1, "Angry's brow is fading out: " + v);
    assert.strictEqual(c.activeName, "Calm");
    clock.t = 1300;
    assert.strictEqual(m.frame(() => c.update()).Brow, 0);
  });
});

test("expressions: clear fades the face back out", () => {
  withClock((clock) => {
    const m = mockFrameModel({ P: 0 });
    const c = new ExpressionController(m.model, { fadeInMs: 100, holdMs: 1000, fadeOutMs: 100 });
    c.apply({ name: "Happy", params: [{ id: "P", value: 1, blend: "Set" }] });
    clock.t = 1200;
    c.clear();
    assert.strictEqual(c.activeName, "neutral");
    clock.t = 1250;
    const v = m.frame(() => c.update()).P;
    assert.ok(v > 0 && v < 1, "fading: " + v);
    clock.t = 1301;
    assert.strictEqual(m.frame(() => c.update()).P, 0);
  });
});

test("blink: scales eye-open, so a narrowed face stays narrowed", () => {
  assert.strictEqual(blinkFactor(-5), 1);
  assert.strictEqual(blinkFactor(0), 1);
  assert.strictEqual(blinkFactor(120), 0, "shut at 120 ms");
  assert.strictEqual(blinkFactor(300), 1, "open again at 300 ms");
  assert.strictEqual(blinkFactor(1e9), 1);
  assert.ok(Math.abs(0.4 * blinkFactor(60) - 0.2) < 1e-9, "a face's 0.4 eye goes to 0.2, never above 0.4");
});

test("lip sync: leaves the face's mouth alone while she is silent", () => {
  const mm = new MouthMixer({ holdMs: 250 });
  const silent = { mouthOpenY: 0, mouthForm: 0, isSpeaking: false };
  assert.strictEqual(mm.step(silent, 0, 1 / 60), 0);
  assert.strictEqual(mm.openY(0.6, 0), 0.6, "a face's open mouth is kept");
  assert.strictEqual(mm.form(-0.8, 0), -0.8, "a face's mouth form is kept");
  // Speaking: the voice takes the mouth over a few frames.
  let t = 0;
  for (let i = 0; i < 30; i++) mm.step({ mouthOpenY: 0.9, mouthForm: 0.5, isSpeaking: true }, (t += 16), 1 / 60);
  assert.ok(mm.weight > 0.99);
  assert.ok(Math.abs(mm.openY(0.2, 0.9) - 0.9) < 0.01, "voice opens the mouth");
  assert.ok(Math.abs(mm.openY(0.7, 0.1) - 0.7) < 0.01, "but never closes a face's open mouth");
  // A short gap between sentences keeps the voice in charge...
  mm.step(silent, t + 100, 1 / 60);
  assert.ok(mm.weight > 0.9, "held across a gap: " + mm.weight);
  // ...and once she stops for good, the face's mouth comes back.
  for (let i = 0; i < 60; i++) mm.step(silent, t + 300 + i * 16, 1 / 60);
  assert.strictEqual(mm.weight, 0);
  assert.strictEqual(mm.openY(0.6, 0.9), 0.6);
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

// --- speech-to-text: Whisper phantom filter (ported from Project-Waifu) ---
const { cleanTranscript } = require("../speechText");

test("cleanTranscript: drops noise tags and short-clip phantoms, keeps real speech", () => {
  assert.strictEqual(cleanTranscript(" Thank you. ", 0.8), "", "phantom on a short clip");
  assert.strictEqual(cleanTranscript("you", 1.0), "");
  assert.strictEqual(cleanTranscript("[Music]", 4), "", "noise tag only");
  assert.strictEqual(cleanTranscript("(coughs) ♪♪", 4), "");
  assert.strictEqual(cleanTranscript("Thank you.", 2.5), "Thank you.", "a long clip is trusted");
  assert.strictEqual(
    cleanTranscript("Thank you for the help [Music]", 1.0),
    "Thank you for the help",
    "a real sentence survives, minus the tag"
  );
  assert.strictEqual(cleanTranscript("", 3), "");
  assert.strictEqual(cleanTranscript(null, 3), "");
});

// --- fullscreen watcher: restarts PowerShell if it exits ---
const { FullscreenWatcher } = require("../fullscreen");
const { EventEmitter: EE } = require("events");

test("fullscreen: watcher restarts after PowerShell exits, and stop() ends it", async () => {
  const kids = [];
  const fakeSpawn = () => {
    const c = new EE();
    c.stdout = new EE();
    c.kill = () => c.emit("exit", 1);
    kids.push(c);
    return c;
  };
  const w = new FullscreenWatcher({ spawn: fakeSpawn, platform: "win32" });
  w.restartMs = 5; // speed the back-off up for the test
  const changes = [];
  w.on("change", (v) => changes.push(v));
  w.start();
  assert.strictEqual(kids.length, 1);
  kids[0].stdout.emit("data", "3\n");
  assert.strictEqual(w.fullscreen, true);
  kids[0].emit("exit", 1); // PowerShell dies
  assert.strictEqual(w.fullscreen, false, "no longer claims fullscreen once the watcher is gone");
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(kids.length, 2, "a new watcher was started");
  w.stop();
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(kids.length, 2, "stop() is final: no restart after a deliberate kill");
  assert.deepStrictEqual(changes, [true, false]);
  assert.strictEqual(new FullscreenWatcher({ spawn: fakeSpawn, platform: "linux" }).start(), undefined);
  assert.strictEqual(kids.length, 2, "never runs off Windows");
});

// --- conversation mode (chat/conversation.js) ---
const Conv = require("../chat/conversation.js");

function fakeTimers() {
  const t = { now: 0, jobs: [] };
  t.setTimeout = (fn, ms) => {
    const job = { fn, at: t.now + ms };
    t.jobs.push(job);
    return job;
  };
  t.clearTimeout = (job) => (t.jobs = t.jobs.filter((j) => j !== job));
  t.advance = (ms) => {
    t.now += ms;
    for (const j of t.jobs.filter((j) => j.at <= t.now)) {
      t.jobs = t.jobs.filter((x) => x !== j);
      j.fn();
    }
  };
  return t;
}

test("conversation: half-duplex gate pauses at once and resumes after a short gap", () => {
  const log = [];
  const t = fakeTimers();
  const g = new Conv.HalfDuplexGate({
    pause: () => log.push("pause"),
    resume: () => log.push("resume"),
    resumeDelayMs: 350,
    setTimeout: t.setTimeout,
    clearTimeout: t.clearTimeout,
  });
  g.update(false); // idle at start
  t.advance(349);
  assert.deepStrictEqual(log, [], "not before the gap");
  t.advance(1);
  assert.deepStrictEqual(log, ["resume"]);
  g.update(true); // she starts speaking
  assert.deepStrictEqual(log, ["resume", "pause"], "paused immediately");
  g.update(true); // repeated signal changes nothing
  g.update(false); // she stops...
  t.advance(200);
  g.update(true); // ...and starts the next sentence before the gap ends
  t.advance(1000);
  assert.deepStrictEqual(log, ["resume", "pause"], "never listened between her sentences");
  g.update(false);
  t.advance(350);
  assert.deepStrictEqual(log, ["resume", "pause", "resume"]);
  g.update(true);
  g.stop();
  g.update(false);
  t.advance(1000);
  assert.deepStrictEqual(log, ["resume", "pause", "resume", "pause", "resume"], "a stopped gate starts fresh");
  // Busy before it ever listened: nothing to pause.
  const log2 = [];
  const g2 = new Conv.HalfDuplexGate({ pause: () => log2.push("pause"), resume: () => log2.push("resume"), setTimeout: t.setTimeout, clearTimeout: t.clearTimeout });
  g2.update(true);
  assert.deepStrictEqual(log2, []);
});

test("conversation: listener wires the detector and reports its states", async () => {
  const states = [];
  const heard = [];
  let opts = null;
  const calls = [];
  const fakeVad = {
    MicVAD: {
      async new(o) {
        opts = o;
        return {
          start: async () => calls.push("start"),
          pause: async () => calls.push("pause"),
          destroy: () => calls.push("destroy"),
        };
      },
    },
  };
  const l = await Conv.createConversationListener({ vad: fakeVad, onState: (s) => states.push(s), onUtterance: (a) => heard.push(a) });
  assert.strictEqual(opts.baseAssetPath, "/vendor/vad/", "files come from the app, never a CDN");
  assert.strictEqual(opts.onnxWASMBasePath, "/vendor/vad/");
  assert.strictEqual(opts.model, "v5");
  assert.strictEqual(opts.startOnLoad, false, "nothing is heard until resume()");
  const ort = { env: { wasm: {} } };
  opts.ortConfig(ort);
  assert.strictEqual(ort.env.wasm.numThreads, 1);
  await l.resume();
  opts.onSpeechRealStart();
  const audio = new Float32Array(16000);
  opts.onSpeechEnd(audio);
  await l.pause();
  l.destroy();
  await l.resume(); // after destroy: ignored
  assert.deepStrictEqual(states, ["starting", "listening", "hearing", "listening", "paused"]);
  assert.strictEqual(heard[0], audio);
  assert.deepStrictEqual(calls, ["start", "pause", "destroy"]);
  await assert.rejects(Conv.createConversationListener({ vad: {}, onState() {}, onUtterance() {} }), /npm install/);
});

test("conversation: status line", () => {
  const s = (o) => Conv.statusLabel({ petSpeaking: false, thinking: false, transcribing: false, listenerState: "listening", ...o }, "Tamamo");
  assert.strictEqual(s({}).text, "Listening");
  assert.strictEqual(s({ listenerState: "hearing" }).text, "Hearing you…");
  assert.strictEqual(s({ transcribing: true }).text, "Got it…");
  assert.strictEqual(s({ thinking: true }).text, "Tamamo is thinking…");
  assert.strictEqual(s({ petSpeaking: true, thinking: true }).text, "Tamamo is speaking");
  assert.strictEqual(s({ listenerState: "paused" }).text, "Paused");
});

// --- saved conversation per model (history.js) ---
const { HistoryStore, MAX_MESSAGES } = require("../history");

test("history: each model keeps its own conversation, across restarts", () => {
  const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), "wp-hist-"));
  try {
    const h = new HistoryStore(dir);
    assert.deepStrictEqual(h.get("Tamamo"), [], "nothing saved yet");
    h.append("Tamamo", [{ role: "user", content: "hi" }, { role: "assistant", content: "hello!" }]);
    h.append("MeiLin", [{ role: "user", content: "hey Mei" }]);
    // A restart reads it back from disk.
    const h2 = new HistoryStore(dir);
    assert.deepStrictEqual(h2.get("Tamamo").map((m) => m.content), ["hi", "hello!"]);
    assert.deepStrictEqual(h2.get("MeiLin").map((m) => m.content), ["hey Mei"]);
    // Clear forgets one model only.
    h2.clear("Tamamo");
    const h3 = new HistoryStore(dir);
    assert.deepStrictEqual(h3.get("Tamamo"), []);
    assert.strictEqual(h3.get("MeiLin").length, 1, "MeiLin's conversation is kept");
  } finally {
    fsx.rmSync(dir, { recursive: true, force: true });
  }
});

test("history: junk is dropped, size is capped, a bad file starts empty", () => {
  const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), "wp-hist-"));
  try {
    const h = new HistoryStore(dir);
    h.append("Tamamo", [
      { role: "system", content: "no system prompts in history" },
      { role: "user", content: "   " },
      null,
      { role: "assistant", content: "x".repeat(30000) },
    ]);
    assert.strictEqual(h.get("Tamamo").length, 1);
    assert.strictEqual(h.get("Tamamo")[0].content.length, 20000);
    const many = Array.from({ length: MAX_MESSAGES + 50 }, (_, i) => ({ role: "user", content: "m" + i }));
    h.append("Tamamo", many);
    const kept = h.get("Tamamo");
    assert.strictEqual(kept.length, MAX_MESSAGES);
    assert.strictEqual(kept[kept.length - 1].content, "m" + (MAX_MESSAGES + 49), "the newest are kept");
    h.append("__proto__", [{ role: "user", content: "x" }]);
    assert.deepStrictEqual(h.get("__proto__"), []);
    h.get("Tamamo").push({ role: "user", content: "not saved" });
    assert.strictEqual(h.get("Tamamo").length, MAX_MESSAGES, "get() returns a copy");
    fsx.writeFileSync(pathx.join(dir, "chat-history.json"), "{not json");
    fsx.rmSync(pathx.join(dir, "chat-history.json.bak"), { force: true });
    assert.deepStrictEqual(new HistoryStore(dir).get("Tamamo"), [], "unreadable file: start empty, no crash");
  } finally {
    fsx.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Content-Security-Policy on every page (code review round 2) ---
test("csp: every page has a strict policy and no inline scripts", () => {
  const pages = ["renderer/index.html", "chat/index.html", "chat/settings.html"];
  for (const page of pages) {
    const html = fsx.readFileSync(pathx.join(__dirname, "..", page), "utf8");
    const m = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
    assert.ok(m, page + " has a CSP meta tag");
    const csp = Object.fromEntries(m[1].split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
    assert.deepStrictEqual(csp["default-src"], ["'self'"], page + ": default-src 'self'");
    assert.deepStrictEqual(csp["object-src"], ["'none'"], page);
    assert.ok(csp["script-src"].includes("'self'"), page);
    for (const bad of ["'unsafe-inline'", "'unsafe-eval'", "*", "http:", "https:", "data:"]) {
      assert.ok(!csp["script-src"].includes(bad), `${page}: script-src must not allow ${bad}`);
    }
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), page + ": no inline <script>");
    assert.ok(!/\son[a-z]+="/.test(html), page + ": no inline event handlers");
    // The CSP must come before any script so it applies to all of them.
    assert.ok(html.indexOf("Content-Security-Policy") < html.indexOf("<script"), page + ": CSP before scripts");
  }
  // Pixi needs its no-eval add-on, loaded right after Pixi itself.
  const pet = fsx.readFileSync(pathx.join(__dirname, "..", "renderer/index.html"), "utf8");
  const a = pet.indexOf("vendor/pixi.min.js"), b = pet.indexOf("vendor/pixi-unsafe-eval.min.js"), c = pet.indexOf("vendor/cubism4.min.js");
  assert.ok(a > -1 && a < b && b < c, "pixi, then its no-eval add-on, then the Live2D plugin");
});

Promise.all(pending).then(() => console.log(`\n${passed} tests passed`));
