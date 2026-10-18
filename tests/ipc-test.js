// Integration tests for the chat/STT plumbing in ipc.js against a throwaway
// local HTTP server. Electron is stubbed so this runs in plain Node.
"use strict";

const assert = require("assert");
const http = require("http");
const Module = require("module");

// Stub "electron" before ipc.js loads it; registered handlers are kept here.
const handlers = {};
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return { ipcMain: { handle: (ch, fn) => (handlers[ch] = fn), on() {} } };
  return realLoad.call(this, request, ...rest);
};
const { streamChat, completeChat, chatCompletionsUrl, ttsSpeechUrl, buildSystemPrompt, registerIpc } = require("../ipc");
Module._load = realLoad;

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log("ok -", name);
  } catch (e) {
    console.error("FAIL -", name, "\n", e);
    process.exitCode = 1;
  }
}

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}/v1` }));
  });
}
const cfgFor = (base) => ({ chat: { baseUrl: base, apiKey: "", model: "m", temperature: 0.5 }, models: {} });
const sse = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

(async () => {
  await test("endpoint URLs are built from any base URL form", () => {
    assert.strictEqual(chatCompletionsUrl("http://x:1"), "http://x:1/v1/chat/completions");
    assert.strictEqual(chatCompletionsUrl("http://x:1/v1/"), "http://x:1/v1/chat/completions");
    assert.strictEqual(ttsSpeechUrl("http://x/v1"), "http://x/v1/audio/speech");
    assert.throws(() => chatCompletionsUrl(""), /not set/);
  });

  await test("streamChat delivers deltas incrementally", async () => {
    const { server, base } = await serve((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        assert.strictEqual(JSON.parse(body).stream, true);
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(sse("Hello"));
        setTimeout(() => res.write(sse(", world")), 30);
        setTimeout(() => res.end("data: [DONE]\n\n"), 60);
      });
    });
    const parts = [];
    const full = await streamChat(cfgFor(base), [{ role: "user", content: "hi" }], { onDelta: (t) => parts.push(t) });
    server.close();
    assert.deepStrictEqual(parts, ["Hello", ", world"]);
    assert.strictEqual(full, "Hello, world");
  });

  await test("streamChat falls back when the server ignores stream:true", async () => {
    const { server, base } = await serve((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "all at once" } }] }));
      });
    });
    const parts = [];
    const full = await streamChat(cfgFor(base), [{ role: "user", content: "hi" }], { onDelta: (t) => parts.push(t) });
    server.close();
    assert.strictEqual(full, "all at once");
    assert.deepStrictEqual(parts, ["all at once"]);
  });

  await test("streamChat surfaces server errors", async () => {
    const { server, base } = await serve((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "bad key" } }));
      });
    });
    await assert.rejects(streamChat(cfgFor(base), [{ role: "user", content: "x" }], { onDelta() {} }), /bad key/);
    server.close();
  });

  await test("streamChat can be cancelled mid-stream", async () => {
    const { server, base } = await serve((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(sse("first"));
        // never finishes
      });
    });
    const ctl = new AbortController();
    const got = [];
    const p = streamChat(cfgFor(base), [{ role: "user", content: "x" }], {
      signal: ctl.signal,
      onDelta: (t) => {
        got.push(t);
        ctl.abort();
      },
    });
    await assert.rejects(p);
    server.closeAllConnections();
    server.close();
    assert.deepStrictEqual(got, ["first"]);
  });

  await test("completeChat returns the reply text", async () => {
    const { server, base } = await serve((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: " hi there " } }] }));
      });
    });
    const text = await completeChat(cfgFor(base), [{ role: "user", content: "x" }], { max_tokens: 5 });
    server.close();
    assert.strictEqual(text, "hi there");
  });

  await test("buildSystemPrompt appends the model's own tags", () => {
    const cfg = { chat: { systemPrompt: "Persona." }, models: {} };
    // The bundled models folder is used if present; with no match it is just the persona.
    const p = buildSystemPrompt(cfg, "no-such-model");
    assert.strictEqual(p, "Persona.");
  });

  await test("history: only the chat window may read, save or clear it", async () => {
    const store = { Tamamo: [{ role: "user", content: "secret" }] };
    const history = {
      get: (m) => store[m] || [],
      append: (m, msgs) => (store[m] = [...(store[m] || []), ...msgs]),
      clear: (m) => delete store[m],
    };
    const settings = { get: () => ({ chat: {}, tts: {}, stt: {}, pet: {}, models: {} }) };
    const origin = "http://127.0.0.1:5555";
    registerIpc(settings, { getLoadedModel: () => "Tamamo", getOrigin: () => origin, history });
    const from = (url) => ({ senderFrame: { url }, sender: { getURL: () => url } });
    const chat = from(origin + "/chat/index.html");
    const got = await handlers["history:get"](chat);
    assert.deepStrictEqual(got, { model: "Tamamo", messages: [{ role: "user", content: "secret" }] });
    for (const intruder of [
      from(origin + "/renderer/index.html"), // the pet window
      from(origin + "/chat/settings.html"), // Settings
      from("http://127.0.0.1:6666/chat/index.html"), // right page, wrong origin
      from("https://example.com/chat/index.html"),
    ]) {
      assert.throws(() => handlers["history:get"](intruder), /only available to the chat window/);
      assert.throws(() => handlers["history:clear"](intruder, { model: "Tamamo" }), /only available/);
    }
    await handlers["history:append"](chat, { model: "Tamamo", messages: [{ role: "assistant", content: "hi" }] });
    assert.strictEqual(store.Tamamo.length, 2);
    await handlers["history:clear"](chat, { model: "Tamamo" });
    assert.strictEqual(store.Tamamo, undefined);
  });

  console.log(`\n${passed} ipc tests passed`);
})();
