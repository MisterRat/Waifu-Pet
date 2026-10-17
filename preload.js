// contextBridge API for the pet, chat, and settings windows.
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

/** Subscribe to a main-process event; returns an unsubscribe function. */
function on(channel, cb) {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("pet", {
  // window controls
  moveBy: (dx, dy) => ipcRenderer.send("window:move-by", dx, dy),
  moveTo: (x, y) => ipcRenderer.send("window:move-to", x, y),
  setScale: (scale) => ipcRenderer.send("window:set-scale", scale),
  setIgnoreMouse: (ignore) => ipcRenderer.send("window:set-ignore-mouse", ignore),
  saveFraming: (framing) => ipcRenderer.send("pet:save-framing", framing),
  quit: () => ipcRenderer.send("window:quit"),
  openChat: () => ipcRenderer.send("window:open-chat"),
  openSettings: () => ipcRenderer.send("window:open-settings"),
  closeChat: () => ipcRenderer.send("chat:close"),
  closeSettings: () => ipcRenderer.send("settings:close"),
  pushLine: (payload) => ipcRenderer.send("chat:push-line", payload),

  // chat
  chatSend: (messages) => ipcRenderer.invoke("chat:send", { messages }),
  chatStream: (messages) => ipcRenderer.invoke("chat:stream", { messages }),
  chatCancel: (id) => ipcRenderer.send("chat:cancel", id),
  chatSystemPrompt: () => ipcRenderer.invoke("chat:system-prompt"),
  ttsSpeak: (text) => ipcRenderer.invoke("tts:speak", { text }),
  sttTranscribe: (audio) => ipcRenderer.invoke("stt:transcribe", { audio }), // Float32Array, 16 kHz mono
  sttStatus: () => ipcRenderer.invoke("stt:status"),
  onSttStatus: (cb) => ipcRenderer.on("stt:status", (_e, status) => cb(status)),

  // settings / models
  settingsGet: () => ipcRenderer.invoke("settings:get"),
  settingsUpdate: (partial) => ipcRenderer.invoke("settings:update", partial),
  modelsList: () => ipcRenderer.invoke("models:list"),
  modelsVocab: () => ipcRenderer.invoke("models:vocab"),
  modelsInspect: (name) => ipcRenderer.invoke("models:inspect", name),
  chatTest: () => ipcRenderer.invoke("chat:test"),
  ttsTest: () => ipcRenderer.invoke("tts:test"),

  // events from main
  onCursor: (cb) => on("pet:cursor", cb), // global cursor, relative to the pet window
  onVisible: (cb) => on("pet:visible", cb), // pet window shown/hidden
  onSettingsChanged: (cb) => on("pet:settings-changed", cb),
  onScale: (cb) => on("pet:scale", cb),
  onChatLine: (cb) => on("chat:line", cb), // a line for the pet to act out / speak
  onChatDelta: (cb) => on("chat:delta", cb), // streamed reply text
  onChatDone: (cb) => on("chat:done", cb),
  onAssistantLine: (cb) => on("chat:assistant-line", cb), // unprompted line to add to the chat log
});
