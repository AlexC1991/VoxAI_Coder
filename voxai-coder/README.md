<div align="center">

```
██╗   ██╗ ██████╗ ██╗  ██╗ █████╗ ██╗    ██████╗ ██████╗ ██████╗ ███████╗██████╗
██║   ██║██╔═══██╗╚██╗██╔╝██╔══██╗██║   ██╔════╝██╔═══██╗██╔══██╗██╔════╝██╔══██╗
██║   ██║██║   ██║ ╚███╔╝ ███████║██║   ██║     ██║   ██║██║  ██║█████╗  ██████╔╝
╚██╗ ██╔╝██║   ██║ ██╔██╗ ██╔══██║██║   ██║     ██║   ██║██║  ██║██╔══╝  ██╔══██╗
 ╚████╔╝ ╚██████╔╝██╔╝ ██╗██║  ██║██║   ╚██████╗╚██████╔╝██████╔╝███████╗██║  ██║
  ╚═══╝   ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝    ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝
```

**The app: working on the code**

`[ Electron 44 ]`  `[ Node agent loop ]`  `[ MIT ]`

</div>

This folder is the Electron app. What it does, downloads and the first run are in the
[README at the repository root](../README.md).

![VoxAI Coder: the chat and the preview](../docs/screenshots/chat-and-preview.png)

---

## ▓▒░ Run, test, build

```bash
npm install
npm start          # the app (prestart refreshes the CSP hash and the Windows UIA helper)
npm run dev        # the same, with dev tools
npm test           # offline regression tests: no model calls, no credits
npm run dist       # Windows installer + portable exe in release/
npm run dist:linux # AppImage + installer script (on Linux; see ../LINUX-BUILD.md)
npm run release -- --notes "..."   # sign update.json and publish to CodeRook
```

On Linux: [../LINUX-BUILD.md](../LINUX-BUILD.md) has the prerequisites (node-pty compiles
during `npm ci`), the build and the release steps, and a map of the Linux code.

`src/renderer/index.html` carries a CSP hash for its inline script. Any edit to it needs
`node scripts/csp.js`; start, dev, test and dist run it for you.

---

## ▓▒░ How a run flows

```
  renderer (index.html)            main (main.js)                backend (agent.js)
 ┌─────────────────────┐  IPC   ┌─────────────────────┐       ┌──────────────────────┐
 │ chat, settings,     │ ─────▶ │ settings, keychain, │ ────▶ │ prompt + tools       │
 │ preview, terminal   │        │ sessions, runs      │       │   │                  │
 │                     │ ◀───── │                     │ ◀──── │   ▼                  │
 └─────────────────────┘ events └─────────────────────┘ yield │ provider ─▶ model    │
        preload.js                                            │   │                  │
     (window.voxai.*)                                         │   ▼                  │
                                                              │ tool calls ─▶ tools/ │
                                                              └──────────────────────┘
```

---

## ▓▒░ Where things are

```
src/
├── main/
│   ├── main.js            settings + keychain, sessions, runs, model catalogue, IPC
│   ├── updater.js         auto-update from the CodeRook feed; checks the signed manifest
│   ├── local-engine.js    llama.cpp engine for local models
│   ├── hf.js              Hugging Face search and downloads
│   └── terminal.js        the terminal panel (interactive.js: commands that need one)
├── preload/preload.js     the context-isolated bridge, window.voxai.*
├── backend/
│   ├── agent.js           the agent loop: prompt, tool calls, checks, events for the UI
│   ├── providers/         streaming provider (OpenRouter and local llama-server)
│   ├── team.js            Team mode: a planner model and a cheaper coder
│   ├── commands.js        /goal  /review  /init  /rewind  /loop
│   ├── compact.js         summarises long sessions
│   ├── sessions.js        session store (JSONL per session)
│   ├── prefix.js          the fixed session prompt the provider can cache
│   ├── profiles.js        per-model cache style and price tiers
│   ├── prune.js           old tool output pruned in batches
│   ├── stuck.js           notices when the model goes in circles
│   ├── projectfacts.js    project overview, commands and the memory worth sending
│   ├── coststats.js       what a message costs on each model
│   ├── tools/             files, patch, shell + terminal, search, memory, skills, MCP,
│   │                      sub-agents, web search + fetch, preview, worktrees, snapshots
│   └── cu/                computer use: Chrome/Edge over CDP, native Windows (UIA)
└── renderer/index.html    the whole UI

resources/skills/          built-in skills
resources/update-key.pem   the PUBLIC update key; the private key never goes in this repo
test/                      regression tests (npm test runs them all)
scripts/                   build, CSP, release and icon helpers
```

---

## ▓▒░ License

[MIT](../LICENSE), like the rest of the repository.
