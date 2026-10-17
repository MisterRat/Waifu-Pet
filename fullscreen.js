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

class FullscreenWatcher extends EventEmitter {
  constructor() {
    super();
    this.fullscreen = false;
    this.child = null;
  }

  start() {
    if (this.child || process.platform !== "win32") return;
    try {
      const encoded = Buffer.from(SCRIPT, "utf16le").toString("base64");
      this.child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
        { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }
      );
    } catch (e) {
      console.warn("[fullscreen] could not start watcher:", e.message);
      this.child = null;
      return;
    }
    let buf = "";
    this.child.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const n = parseInt(buf.slice(0, i).trim(), 10);
        buf = buf.slice(i + 1);
        if (Number.isFinite(n)) this._set(FULLSCREEN_STATES.has(n));
      }
    });
    this.child.on("error", () => (this.child = null));
    this.child.on("exit", () => {
      this.child = null;
      this._set(false);
    });
  }

  stop() {
    if (this.child) {
      try {
        this.child.kill();
      } catch {}
      this.child = null;
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
