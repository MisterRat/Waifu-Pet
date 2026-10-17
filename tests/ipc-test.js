// Integration tests for the chat/STT plumbing in ipc.js against a throwaway
// local HTTP server. Electron is stubbed so this runs in plain Node.
"use strict";

const assert = require("assert");
const http = require("http");
const Module = require("module");

// Stub "electron" before ipc.js loads it.
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return { ipcMain: { handle() {}, on() {} } };
  return realLoad.call(this, request, ...rest);
};
const { streamChat, completeChat, chatCompletionsUrl, ttsSpeechUrl, buildSystemPrompt } = require("../ipc");
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

  console.log(`\n${passed} ipc tests passed`);
})();
