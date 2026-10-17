# VoxAI Coder: the app

This folder is the Electron app. What it does, downloads and the first run are in the
[README at the repository root](../README.md); this page is for working on the code.

## Run, test, build

```bash
npm install
npm start          # the app (prestart refreshes the CSP hash and the Windows UIA helper)
npm run dev        # the same, with dev tools
npm test           # offline regression tests: no model calls, no credits
npm run dist       # Windows installer + portable exe in release/
npm run dist:linux # AppImage + installer script (on Linux; see ../LINUX-BUILD.md)
npm run release -- --notes "..."   # sign update.json and publish to CodeRook
```

`src/renderer/index.html` carries a CSP hash for its inline script. Any edit to it needs
`node scripts/csp.js` (start, dev, test and dist run it for you).

## Where things are

| Path | What is there |
|---|---|
| `src/main/main.js` | Electron main: settings and keychain, sessions, runs, model catalogue, OpenRouter account, IPC |
| `src/main/updater.js` | Auto-update from the CodeRook feed; checks the signed manifest |
| `src/main/local-engine.js`, `hf.js` | llama.cpp engine for local models; Hugging Face search and downloads |
| `src/main/terminal.js`, `interactive.js` | The terminal panel and interactive commands |
| `src/preload/preload.js` | The context-isolated bridge, `window.voxai.*` |
| `src/backend/agent.js` | The agent loop: prompt, tool calls, checks, events for the UI |
| `src/backend/providers/openrouter.js` | Streaming provider (OpenRouter and local llama-server) |
| `src/backend/team.js` | Team mode: a planner model and a cheaper coder |
| `src/backend/prefix.js`, `profiles.js`, `prune.js`, `stuck.js`, `projectfacts.js`, `coststats.js` | Token and cost savings: the cached prompt, per-model cache and price rules, pruning, the stuck detector, project facts, cost per message |
| `src/backend/compact.js` | Summarises long sessions |
| `src/backend/sessions.js` | Session store (JSONL per session) |
| `src/backend/commands.js` | Slash commands: `/goal`, `/review`, `/init`, `/rewind`, `/loop` |
| `src/backend/tools/` | The tools: files, patch, shell and terminal, search, memory, skills, MCP, sub-agents, web search and fetch, preview browser, worktrees, snapshots |
| `src/backend/cu/` | Computer use: Chrome/Edge over CDP and native Windows control (UI Automation) |
| `src/renderer/index.html` | The whole UI |
| `resources/skills/` | Built-in skills |
| `resources/update-key.pem` | The **public** update key. The private key never goes in this repo. |
| `test/` | Regression tests (`npm test` runs them all) |
| `scripts/` | Build, CSP, release and icon helpers |
