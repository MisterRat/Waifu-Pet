// Detects when a fullscreen game/video/presentation is running (Windows) so the
// pet can hide instead of covering it or costing GPU time.
//
// Uses the shell's SHQueryUserNotificationState (the same signal Windows uses
// to suppress notifications) via one long-lived hidden PowerShell process that
// prints the state every couple of seconds. No native modules required. On
// other platforms (or if PowerShell is unavailable) it simply never reports
// fullscreen.
"use strict";

const { spawn } = require("child_process");
const { EventEmitter } = require("events");

// QUERY_USER_NOTIFICATION_STATE: 2 = busy (fullscreen app / presentation
// settings), 3 = Direct3D fullscreen, 4 = presentation mode.
const FULLSCREEN_STATES = new Set([2, 3, 4]);

const SCRIPT = `
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class Q { [DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int s); }'
while ($true) {
  $s = 0
  [void][Q]::SHQueryUserNotificationState([ref]$s)
  [Console]::Out.WriteLine($s)
  [Console]::Out.Flush()
  Start-Sleep -Seconds 2
}
`;

// If PowerShell exits (killed, crashed, logged off), start it again after a
// back-off: 2 s, doubling up to 60 s. A run that lasted a minute resets it.
const RESTART_MIN_MS = 2000;
const RESTART_MAX_MS = 60000;
const HEALTHY_RUN_MS = 60000;

class FullscreenWatcher extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {Function} [opts.spawn] child_process.spawn (injectable for tests)
   * @param {string} [opts.platform] defaults to process.platform
   */
  constructor(opts = {}) {
    super();
    this.fullscreen = false;
    this.child = null;
    this.spawn = opts.spawn || spawn;
    this.platform = opts.platform || process.platform;
    this.wanted = false; // true between start() and stop()
    this.restartMs = RESTART_MIN_MS;
    this.restartTimer = null;
    this.restarts = 0;
  }

  start() {
    if (this.platform !== "win32") return;
    this.wanted = true;
    if (this.child || this.restartTimer) return;
    this._launch();
  }

  _launch() {
    let child;
    try {
      const encoded = Buffer.from(SCRIPT, "utf16le").toString("base64");
      child = this.spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
        { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }
      );
    } catch (e) {
      console.warn("[fullscreen] could not start watcher:", e.message);
      this._scheduleRestart(0);
      return;
    }
    this.child = child;
    const startedAt = Date.now();
    let gone = false;
    const onGone = () => {
      if (gone) return; // "error" and "exit" can both fire
      gone = true;
      if (this.child === child) this.child = null;
      this._set(false);
      this._scheduleRestart(Date.now() - startedAt);
    };
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const n = parseInt(buf.slice(0, i).trim(), 10);
        buf = buf.slice(i + 1);
        if (Number.isFinite(n)) this._set(FULLSCREEN_STATES.has(n));
      }
    });
    child.on("error", onGone);
    child.on("exit", onGone);
  }

  _scheduleRestart(ranMs) {
    if (!this.wanted || this.restartTimer) return;
    if (ranMs >= HEALTHY_RUN_MS) this.restartMs = RESTART_MIN_MS;
    const delay = this.restartMs;
    this.restartMs = Math.min(RESTART_MAX_MS, this.restartMs * 2);
    console.warn(`[fullscreen] watcher stopped; restarting in ${Math.round(delay / 1000)} s`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.wanted) return;
      this.restarts++;
      this._launch();
    }, delay);
    if (this.restartTimer.unref) this.restartTimer.unref();
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.kill();
      } catch {}
    }
    this._set(false);
  }

  _set(v) {
    if (v === this.fullscreen) return;
    this.fullscreen = v;
    this.emit("change", v);
  }
}

module.exports = { FullscreenWatcher };
