# Waifu Pet

A Live2D desktop pet for Windows (Electron). She lives in a transparent,
click-through window on your desktop: you can see and use everything under her
except the pixels of the model itself. She chats through any OpenAI-compatible
LLM, speaks through any OpenAI-compatible TTS server, and can listen through
built-in Whisper speech-to-text (runs locally; the model downloads the first time voice input is enabled).

The app is **model-agnostic**. Every folder in `models/` that contains a
`*.model3.json` shows up as a choice in Settings; nothing in the code depends
on a particular model. Tamamo is bundled and is the default.

## Download

Ready-built `WaifuPet.exe` files are on the repo's **Releases** page. GitHub
builds one each night when something new has been merged into `main`; the
**Run workflow** button on the Actions tab (*Build Windows exe*) builds one on
demand. The exe includes the Tamamo model; put any other model folder into a
`models` folder next to the exe. It isn't code-signed, so Windows SmartScreen
may ask you to confirm the first time (**More info → Run anyway**).

## Run

```
start.bat          (installs dependencies on first run, then starts)
```

or `npm install` once, then `npm start`. Requires Node.js 18+ and a Windows 10/11
desktop. The tray icon has Show/Hide, Chat, Settings, Size, Model and Quit.

## Build a single `.exe`

```
build.bat
```

installs dependencies, runs the tests and produces **`dist\WaifuPet.exe`**: one
portable file (no installer) that you can move anywhere. Tamamo is bundled inside
it. To add more models, put model folders into a `models` folder **next to the
.exe**, or use the tray menu → *Open Models Folder*. A model there with the same
folder name as a bundled one overrides it.

Notes: the portable exe unpacks itself to a temporary folder on every launch, so
startup takes a few seconds longer than `npm start`. Settings are stored in
`%APPDATA%\waifu-pet`, shared with `npm start`. The exe is not code-signed, so
Windows SmartScreen may warn the first time ("More info" → "Run anyway").

## Using her

| Action | Result |
|---|---|
| Left-click | She reacts |
| Left-drag | Move her anywhere on any monitor |
| Mouse wheel | Zoom the model inside the window (0.4× to 20×) |
| Right-drag | Move the model up/down inside the window |
| Tray → Chat | Open the chat window |

Zoom and position are remembered **per model**.

Behaviour (each part has an off switch in Settings):

- Her eyes and head follow the mouse **only while it is moving**, anywhere on the
  desktop, then she looks forward again. She looks forward while she talks.
- When idle she fidgets, glances to the side and occasionally changes mood,
  using only the motions and expressions her model actually has.
- She speaks up now and then, greets you at launch and welcomes you back after
  a long absence (needs the chat server).
- Replies stream in and she starts speaking sentence by sentence.
- Each model remembers its own conversation, also after the chat window or the
  app is closed; her greetings and remarks are part of it. She is sent the last
  10 messages as context. 🗑 in the chat title bar clears the current model's
  conversation (the others are kept).
- Voice input in chat (turn on *Voice input* in Settings):
  - 🎤 push to talk: click, speak, click again.
  - 🗣 **conversation mode**: hands-free. Just talk; when you pause she
    answers. Voice detection (Silero, running locally) tells speech from noise,
    and the microphone pauses while she is thinking or speaking so she never
    answers herself. The status line above the input shows what it is doing.
- She hides while a fullscreen game or video runs, stops drawing while hidden,
  and is capped at 30 fps by default.

## Settings

Open from the tray. Chat and TTS each take a base URL (for example
`http://localhost:11434/v1`), an optional API key and a model name. Per model you
can set a persona prompt, a TTS voice and the framing. The **Model check** panel
lists what the selected model ships and what will work (blinking, lip sync, eye
and head following, idle motions, oversized textures).

Settings live in `%APPDATA%\waifu-pet\settings.json`. API keys are encrypted
with Windows DPAPI and only the Settings window can read them. Conversations are
saved per model in `%APPDATA%\waifu-pet\chat-history.json` (the latest 200
messages each); only the chat window can read them.

## Adding a model

Drop a Live2D (Cubism 3/4/5) model folder into `models/` (or, for the packaged
exe, a `models` folder next to it / `%APPDATA%\waifu-pet\models`); it appears in
Settings and in the tray immediately, no restart needed. Optional files she makes use of:

- `*.exp3.json` expressions. Their file names become the emotion tags the LLM may
  use (`Happy.exp3.json` → `[happy]`). The chat window tells the LLM exactly which
  tags the current model has. Faces are layered on top of her motion and fade
  back cleanly; their mouth shape shows whenever she isn't speaking, and blinks
  close the eyes from wherever the face has them.
- `waifu-faces.json` (optional) tunes faces without editing the `.exp3.json`
  files: `{"skip": ["Crying"], "map": {"crying": "Sad"}}`.
- `*.motion3.json` motions (in the folder or a `Motions/` subfolder). Files named
  `Idle_*` loop while she is idle; every other motion is a reaction and a motion
  tag (`Wave.motion3.json` → `[wave]`). Motions declared in `model3.json` are
  honoured too (group `Idle` = idle loop).
- A `.cdi3.json` file, so the Model check can verify the parameters.
- Blink and lip-sync parameters come from the model's `EyeBlink` / `LipSync`
  groups; the Cubism-standard names are the fallback.

## Command-line flags

`npm start -- <flags>`

| Flag | Purpose |
|---|---|
| `--model <folder>` | Load a specific model for this run |
| `--tint` | Faint red wash: shows whether the window is truly transparent |
| `--opaque` | Disable window transparency |
| `--diag` | Log GL info and scan the model for broken drawables |
| `--diag-log <file>` | Also write renderer console output to a file |
| `--probe=<ParamId[:value]>` | Force a Live2D parameter (debugging a rig) |
| `--shot <file>` | Save a screenshot of the pet window after loading |
| `--nomotion`, `--noblink`, `--noexpr`, `--nolipsync`, `--noidle` | Switch subsystems off to isolate a rendering problem |

## Troubleshooting

- **Solid box instead of a transparent window:** run with `--tint`. If you see a
  black/white box, Windows isn't compositing the window as transparent; update
  the GPU driver or try software rendering (`--cpu`).
- **Parts of the model missing or garbled:** check the Model check panel. Textures
  larger than 4096×4096 fail on some GPUs; downscale them.
- **No voice:** use *Test TTS* in Settings; check the server is running.
- **Log file:** `%APPDATA%\waifu-pet\boot-trace.log`.

## Project layout

```
main.js            Electron main process: windows, tray, cursor tracking, fullscreen, proactive
ipc.js             Chat / streaming / TTS proxies, speech-to-text IPC, prompts, settings access
stt.js             Built-in Whisper lifecycle (download, load, unload)
stt-worker.js      Whisper worker process (Transformers.js)
speechText.js      Strips [tags] so they are never spoken; filters words Whisper invents from noise
settings.js        Settings store (atomic writes, encrypted API keys)
history.js         Saved conversation per model
models.js          Model discovery and the model health check
server.js          Local static file server (whitelisted folders, loopback only)
fullscreen.js      Fullscreen-app detection (Windows)
proactive.js       Greetings / welcome-back / remark scheduler
extractContent.js  Parsing of chat completion responses and SSE streams
preload.js         Bridge between the windows and the main process
renderer/          Pet window: pet.js, idle.js, expressions.js, tagParser.js, lipsync.js, debug.js
chat/              Chat and Settings windows (conversation.js: hands-free conversation mode)
assets/            Tray icon and app icon (npm run icon generates icon.png)
vendor/            Live2D Cubism Core, Pixi and the Live2D plugin; vendor/vad/ is the voice-detection
                   runtime (all copied from node_modules by npm install; vad/ is not in git)
models/            Bundled / dev models (one folder each; only Tamamo is in git, see .gitignore)
build.bat          Builds dist\WaifuPet.exe
start.bat          Installs dependencies if needed and runs the app
tests/             npm test
```

## Tests

`npm test` runs unit tests for the parsers, faces (blending, cross-fades, blink
and lip-sync mixing), idle and proactive scheduling, settings, model inspection,
the fullscreen watcher's restart, and an integration test of the streaming chat
path against a local fake server.

## Security notes

- The local file server only serves `renderer/`, `chat/`, `vendor/`, `assets/` and
  the model folders, and only answers loopback hosts.
- All windows are sandboxed with context isolation; popups and navigation away
  from the app are blocked, and every permission request is denied except
  microphone capture for the chat window.
- Chat and TTS requests are made by the main process, so API keys
  never reach the web pages.
- Every page has a strict Content-Security-Policy: only the app's own files
  may load or run, with no inline scripts, no `eval` and nothing from the
  internet. WebAssembly is allowed for the Live2D core and voice detection,
  and Pixi runs without `eval` through `@pixi/unsafe-eval`.

## Licensing

The code is released under the [MIT License](LICENSE), with these exceptions:

- **The Tamamo model (`models/Tamamo/`) is not covered by the MIT License. It
  was commissioned by MisterRat, who owns all rights to it, including commercial
  rights. All rights reserved: it is not licensed for reuse, modification or
  redistribution outside this project** (see `models/Tamamo/LICENSE.txt`).
- The Live2D Cubism Core (`vendor/live2dcubismcore.min.js`) is proprietary and
  subject to Live2D's own license.
- Third-party libraries keep their own licenses (PixiJS and pixi-live2d-display
  are MIT).
- Any other model you add to `models/` is subject to its own license; only ship
  models you have the right to distribute.
