// settings.js — settings window logic.
"use strict";

const $ = (id) => document.getElementById(id);

function setStatus(el, ok, text) {
  el.textContent = text;
  el.className = "status " + (ok ? "ok" : "err");
}

// ---- sidebar tabs ----
document.querySelectorAll("nav button.tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("nav button.tab").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll("section.page").forEach((p) => p.classList.toggle("active", p.id === btn.dataset.page));
    document.querySelector("main").scrollTop = 0;
  });
});

// ---- built-in Whisper status ----
function showSttStatus(st) {
  if (!st) return;
  const bar = $("sttBar");
  const el = $("sttStatus");
  const pct = st.state === "ready" ? 100 : st.state === "off" || st.state === "error" ? 0 : st.percent || 8;
  bar.style.width = pct + "%";
  const text =
    st.state === "off" ? "Off (not loaded)"
    : st.state === "loading" ? "Loading…"
    : st.state === "downloading" ? `Downloading model… ${st.percent}%`
    : st.state === "ready" ? "Ready, Whisper is loaded"
    : "Error: " + st.message;
  el.textContent = text;
  el.className = "status " + (st.state === "ready" ? "ok" : st.state === "error" ? "err" : "");
}
window.pet.onSttStatus(showSttStatus);
window.pet.sttStatus().then(showSttStatus).catch(() => {});

// ---- live value labels next to sliders ----
const RANGE_FORMAT = {
  frameZoom: (v) => v.toFixed(2) + "×",
  frameX: (v) => v.toFixed(2),
  frameY: (v) => v.toFixed(2),
  tailWagGain: (v) => v.toFixed(1) + "×",
};
function updateRangeLabels() {
  for (const id of Object.keys(RANGE_FORMAT)) {
    const label = $(id + "Val");
    if (label) label.textContent = RANGE_FORMAT[id](parseFloat($(id).value));
  }
}
for (const id of Object.keys(RANGE_FORMAT)) $(id).addEventListener("input", updateRangeLabels);

window.pet
  .settingsGet()
  .then(async (s) => {
    // Populate the model picker from the models/ folder.
    const models = await window.pet.modelsList();
    const sel = $("petModel");
    sel.innerHTML = "";
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.name;
      opt.textContent = m.name;
      sel.appendChild(opt);
    }
    sel.value = models.some((m) => m.name === s.pet.model) ? s.pet.model : (models[0] && models[0].name);
    fillModelOverrides(s.models || {});
    sel.addEventListener("change", () => {
      fillModelOverrides(s.models || {});
      runModelCheck();
    });
    $("chatBaseUrl").value = s.chat.baseUrl;
    $("chatApiKey").value = s.chat.apiKey;
    $("chatModel").value = s.chat.model;
    $("systemPrompt").value = s.chat.systemPrompt;
    $("chatStream").checked = s.chat.stream !== false;
    $("sttEnabled").checked = !!s.stt.enabled;
    $("sttModel").value = s.stt.model || "base";
    $("sttLanguage").value = s.stt.language || "auto";
    $("sttAutoSend").checked = s.stt.autoSend !== false;
    $("lookAtMouse").checked = s.pet.lookAtMouse !== false;
    $("idleBehavior").checked = s.pet.idleBehavior !== false;
    $("proEnabled").checked = s.proactive.enabled !== false;
    $("proGreetings").checked = s.proactive.greetings !== false;
    $("proMin").value = s.proactive.minMinutes;
    $("proMax").value = s.proactive.maxMinutes;
    $("perfFps").value = String(s.perf.maxFps);
    $("perfPause").checked = s.perf.pauseWhenHidden !== false;
    $("perfFullscreen").checked = s.perf.hideOnFullscreen !== false;
    $("ttsEnabled").checked = s.tts.enabled;
    $("ttsBaseUrl").value = s.tts.baseUrl;
    $("ttsApiKey").value = s.tts.apiKey || "";
    $("ttsModel").value = s.tts.model;
    $("ttsVoice").value = s.tts.voice;
    $("petScale").value = String(s.pet.scale);
    $("alwaysOnTop").checked = s.pet.alwaysOnTop;
    $("tailWagGain").value = Number.isFinite(s.pet.tailWagGain) ? s.pet.tailWagGain : 2.5;
    updateRangeLabels();
    runModelCheck();
  })
  .catch((e) => setStatus($("saveStatus"), false, "Load failed: " + e.message));

// Load the selected model's per-model overrides into the form fields.
function fillModelOverrides(models) {
  const name = $("petModel").value;
  const o = models[name] || {};
  $("modelSystemPrompt").value = o.systemPrompt || "";
  $("modelVoice").value = o.voice || "";
  const f = o.framing || {};
  $("frameZoom").value = Number.isFinite(f.zoom) ? f.zoom : 1;
  $("frameX").value = Number.isFinite(f.x) ? f.x : 0;
  $("frameY").value = Number.isFinite(f.y) ? f.y : 0;
  updateRangeLabels();
}

// Health check for the selected model: what it ships and what will work.
async function runModelCheck() {
  const box = $("modelCheck");
  const name = $("petModel").value;
  if (!name) {
    box.textContent = "";
    return;
  }
  try {
    const { checks } = await window.pet.modelsInspect(name);
    box.innerHTML = "";
    const icon = { ok: "✓", warn: "⚠", error: "✗" };
    for (const c of checks) {
      const div = document.createElement("div");
      div.className = "chk " + c.level;
      div.textContent = icon[c.level] + " " + c.text;
      box.appendChild(div);
    }
  } catch (e) {
    box.textContent = "Check failed: " + e.message;
  }
}

$("resetFrame").addEventListener("click", () => {
  $("frameZoom").value = 1;
  $("frameX").value = 0;
  $("frameY").value = 0;
  updateRangeLabels();
});

function collect() {
  const modelName = $("petModel").value;
  const modelOverride = {
    systemPrompt: $("modelSystemPrompt").value.trim(),
    voice: $("modelVoice").value.trim(),
    framing: {
      zoom: parseFloat($("frameZoom").value),
      x: parseFloat($("frameX").value),
      y: parseFloat($("frameY").value),
    },
  };
  return {
    chat: {
      baseUrl: $("chatBaseUrl").value.trim(),
      apiKey: $("chatApiKey").value.trim(),
      model: $("chatModel").value.trim(),
      systemPrompt: $("systemPrompt").value,
      stream: $("chatStream").checked,
    },
    stt: {
      enabled: $("sttEnabled").checked,
      model: $("sttModel").value,
      language: $("sttLanguage").value,
      autoSend: $("sttAutoSend").checked,
    },
    proactive: {
      enabled: $("proEnabled").checked,
      greetings: $("proGreetings").checked,
      minMinutes: Math.max(5, parseInt($("proMin").value, 10) || 20),
      maxMinutes: Math.max(5, parseInt($("proMax").value, 10) || 45),
    },
    perf: {
      maxFps: parseInt($("perfFps").value, 10),
      pauseWhenHidden: $("perfPause").checked,
      hideOnFullscreen: $("perfFullscreen").checked,
    },
    tts: {
      enabled: $("ttsEnabled").checked,
      baseUrl: $("ttsBaseUrl").value.trim(),
      apiKey: $("ttsApiKey").value.trim(),
      model: $("ttsModel").value.trim(),
      voice: $("ttsVoice").value.trim(),
    },
    pet: {
      model: $("petModel").value,
      scale: parseFloat($("petScale").value),
      alwaysOnTop: $("alwaysOnTop").checked,
      lookAtMouse: $("lookAtMouse").checked,
      idleBehavior: $("idleBehavior").checked,
      tailWagGain: parseFloat($("tailWagGain").value),
    },
    models: {
      // Only the selected model is editable here; other entries are preserved
      // by the deepMerge in settings.update.
      [modelName]: modelOverride,
    },
  };
}

$("save").addEventListener("click", async () => {
  const data = collect();
  try {
    await window.pet.settingsUpdate(data);
    // Apply the Size setting immediately (resizes the pet window in place).
    window.pet.setScale(data.pet.scale);
    setStatus($("saveStatus"), true, "Saved.");
  } catch (e) {
    setStatus($("saveStatus"), false, "Save failed: " + e.message);
  }
});

$("testChat").addEventListener("click", async () => {
  // Save first so the test uses the current values.
  await window.pet.settingsUpdate(collect());
  setStatus($("chatStatus"), true, "Testing…");
  try {
    const r = await window.pet.chatTest();
    if (r.ok) setStatus($("chatStatus"), true, "✓ " + (r.reply || "OK"));
    else setStatus($("chatStatus"), false, "✗ " + (r.error || "failed"));
  } catch (e) {
    setStatus($("chatStatus"), false, "✗ " + (e.message || String(e)));
  }
});

$("testTts").addEventListener("click", async () => {
  await window.pet.settingsUpdate(collect());
  setStatus($("ttsStatus"), true, "Testing…");
  try {
    const r = await window.pet.ttsTest();
    if (r.ok) setStatus($("ttsStatus"), true, "✓ OK");
    else setStatus($("ttsStatus"), false, "✗ " + (r.error || "failed"));
  } catch (e) {
    setStatus($("ttsStatus"), false, "✗ " + (e.message || String(e)));
  }
});

$("close").addEventListener("click", () => window.pet.closeSettings());
