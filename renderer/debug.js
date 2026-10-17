// debug.js — opt-in diagnostics for the pet window, kept out of pet.js.
// Activated by URL flags (npm start -- --probe=... / --diag):
//   ?probe=<ParamId[:value]>[,...]  force Live2D parameters every frame
//   ?diag                           dump GL info + a drawable health check
//   ?testhook                       expose { app, model } as window.__waifu (automated tests)
// A texture-load summary is always logged once at startup.
"use strict";

(function () {
  function install({ app, model, params }) {
    if (params.has("testhook")) window.__waifu = { app, model };

    // ?probe=<ParamId[:value]>[,...]: force parameters every frame to verify
    // which params actually drive visible parts. The core model update runs in
    // the render phase, so a ticker-based set would be overwritten;
    // "beforeModelUpdate" fires right before it, so sets made there survive.
    if (params.has("probe")) {
      const probes = (params.get("probe") || "")
        .split(",")
        .filter(Boolean)
        .map((s) => {
          const [id, v] = s.split(":");
          return [id, v === undefined ? 1 : parseFloat(v) || 0];
        });
      model.internalModel.on("beforeModelUpdate", () => {
        const cm = model.internalModel.coreModel;
        for (const [id, v] of probes) cm.setParameterValueById(id, v);
      });
      console.log("[pet] probe debug: forcing", probes.map(([i, v]) => i + "=" + v).join(", "));
    }

    // ?diag: WebGL info plus a scan of EVERY drawable for NaN vertices or
    // missing clipping contexts (model-agnostic: no part names are assumed).
    if (params.has("diag")) {
      try {
        const cm = model.internalModel.coreModel;
        const ids = cm.getDrawableIds();
        const gl = app.renderer.gl;
        const dbg = gl.getExtension("WEBGL_debug_renderer_info");
        console.log(
          "[diag] GL " +
            JSON.stringify({
              api: gl instanceof WebGL2RenderingContext ? "WebGL2" : "WebGL1",
              renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "(no info ext)",
              vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : "?",
              maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
              maxViewport: gl.getParameter(gl.MAX_VIEWPORT_DIMS),
            })
        );
        const cmgr = model.internalModel.renderer._clippingManager;
        const clipForDraw = cmgr ? cmgr.getClippingContextListForDraw() : null;
        let bad = 0;
        for (let i = 0; i < ids.length; i++) {
          const v = cm.getDrawableVertices(i);
          let nan = false;
          for (let k = 0; k < v.length; k++) {
            if (Number.isNaN(v[k])) {
              nan = true;
              break;
            }
          }
          const masked = cm.getDrawableMaskCounts ? cm.getDrawableMaskCounts()[i] > 0 : false;
          const noCtx = masked && clipForDraw && !clipForDraw[i];
          if (nan || noCtx) {
            bad++;
            console.log(`[diag] drawable ${ids[i]}: ${nan ? "NaN vertices " : ""}${noCtx ? "masked but no clipping context" : ""}`);
          }
        }
        console.log(`[diag] scanned ${ids.length} drawables, ${bad} problem(s)`);
      } catch (e) {
        console.log("[diag] FAILED: " + e.message);
      }
    }

    // Texture load summary (console only — no on-screen overlay).
    try {
      const texs = model.textures || [];
      const rows = texs.map((t, i) => {
        const bt = t && t.baseTexture ? t.baseTexture : t;
        return `tex${i}=${bt.width}x${bt.height}${t && t.valid ? "" : "(invalid)"}`;
      });
      console.log("[tex] " + rows.join(" "));
    } catch (e) {
      console.warn("[tex] dump failed:", e.message);
    }
  }

  window.WaifuDebug = { install };
})();
