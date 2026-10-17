# VoxAI Coder

A desktop coding agent for Windows and Linux. You describe what you want and it reads your
project, edits files, runs commands, checks its work in a browser and reports back. It runs
on your own [OpenRouter](https://openrouter.ai) key, so you choose the model and pay only for
what you use, or on a model running on your own PC.

The agent loop is VoxAI Coder's own (Node, inside Electron). It needs no external agent
binary or subscription.

## Download

- **Windows:** [VoxAI-Coder-Setup-0.2.85.exe](https://api.coderook.com/v1/public/projects/batty-251/voxai-coder-releases/updates/VoxAI-Coder-Setup-0.2.85.exe)
  from CodeRook, or from [GitHub Releases](https://github.com/AlexC1991/VoxAI_Coder/releases).
- **Linux:** an installer script and AppImage, from the
  [releases project](https://coderook.com/batty-251/voxai-coder-releases) when a Linux build
  is out for the current version.

Once installed, the app updates itself. It checks for new versions when it opens, downloads
them in the background and offers to restart when one is ready. Updates come from CodeRook
and are installed only when their signature and checksum match.

## First run

1. Open **Settings → Account**, paste your OpenRouter key and save. A management key is
   optional; it shows your balance and lets you add credits.
2. Pick a model in the chat bar, choose a project folder and send a message.

Keys are kept in the system keychain (Windows: DPAPI through Electron `safeStorage`) and are
sent only to OpenRouter.

## What it does

**Models**
- Every model on OpenRouter, browsed by company, with the price per message shown before
  you send.
- Local models on Windows through llama.cpp (Vulkan). The engine downloads once and is checked
  against its published SHA-256. GGUF models can be searched and downloaded from Hugging
  Face inside the app.
- Team mode: a stronger model plans and reviews, and a cheaper one writes the code.
- Sub-agents for side tasks, each with its own model.

**Working on a project**
- Reads, writes, edits and patches files, and searches the project. Shell commands run in
  a terminal panel you can watch.
- A preview browser for web apps, and computer use for desktop apps.
- Permission modes: *Ask first*, *Edit files*, *Edit and test*, *Auto* (a safety check
  decides what needs asking) and *Full access*. Work stays inside the project folder.
- Plan mode, a running task list, and **Review changes**, then commit or open a pull
  request.
- Slash commands:
  - `/goal` keeps working until a separate check agrees it is done.
  - `/review` reviews uncommitted changes.
  - `/init` writes `AGENTS.md`.
  - `/rewind` undoes the last run's file changes.
  - `/loop` repeats a task on a timer.

**Context and memory**
- Project memory, `AGENTS.md`, and skills (built-in ones for GitHub, GitLab, Codeberg,
  CodeRook, the preview browser and computer use, plus your own).
- MCP servers, which can be added, tested, switched on and off, or imported in Settings.
- Long sessions are compacted, and old tool output is pruned in batches so the prompt
  cache keeps working.

**Cost**
- Live cost for each message and session, a usage history with sortable columns, and
  spending limits.
- Measures that save tokens:
  - a fixed session prompt that stays cached;
  - only the memory that is relevant to the request;
  - a project overview and its commands;
  - a stuck-loop detector;
  - a check before the agent says it is done;
  - duplicate tools left out of what the model is sent.

## Build from source

You need Node.js 20 or newer (developed on Node 24) and Windows or Linux.

```bash
cd voxai-coder
npm install
npm start        # run the app
npm test         # offline regression tests (no model calls, no credits)
npm run dist     # Windows installer and portable exe in voxai-coder/release
```

The Linux build is `npm run dist:linux`; see [LINUX-BUILD.md](LINUX-BUILD.md).

## Layout

| Path | What is there |
|---|---|
| `voxai-coder/src/main` | Electron main process: settings, keychain, sessions, updater, local engine, Hugging Face downloads |
| `voxai-coder/src/backend` | The agent loop, providers, tools, Team mode, cost tracking and the prompt and pruning logic |
| `voxai-coder/src/renderer` | The UI (a single `index.html`) |
| `voxai-coder/src/preload` | The bridge between the UI and the main process (`window.voxai`) |
| `voxai-coder/resources` | Icons, built-in skills and the public update key |
| `voxai-coder/test` | Regression tests |
| `benchmark` | Benchmark runs against other agents |

## License

[MIT](LICENSE)
