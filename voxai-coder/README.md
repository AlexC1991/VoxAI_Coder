# VoxAI Coder

A desktop coding agent (Electron) that bills through your OpenRouter key.
Own backend (no external agent binaries), enforced workdir sandbox, Vox Text
Engine rendering, and a growing power-tool surface for caching, memory, and
project handling.

## Quick start
```
npm start
```
Settings → paste OpenRouter key (and optionally a management key for account
credits) → Save → pick a model → send a message.

## Architecture
- `src/main/main.js` — Electron main: settings/keychain, sessions, agent
  orchestration, OpenRouter account usage, model catalog, IPC.
- `src/preload/preload.js` — context-isolated bridge (`window.voxai.*`).
- `src/backend/agent.js` — tool-calling loop (streams tokens live via
  `onLiveEvent`, executes tools, yields UI events).
- `src/backend/providers/openrouter.js` — SSE streaming provider with
  `include_usage_cost` + `stream_options.include_usage`.
- `src/backend/sessions.js` — JSONL per-session store.
- `src/backend/compact.js` — conversation compactor (auto-summarizes long
  sessions into a `[VOX COMPACTED CONTEXT]` recap, keeps recent messages).
- `src/backend/tools/` — the tool surface (see below).
- `src/backend/cu/` — Computer Use: a persistent Chrome/Edge CDP
  browser backend (`cdp.js`), a native Windows controller (`native.js`),
  and the agent tool surface (`index.js`).
- `src/renderer/` — Forge-styled UI; Vox Text Engine (`vendor/vte.browser.js`)
  filters leaks, normalizes markdown, and drives the typewriter reveal.

## Tool surface (42)
| Tool | Purpose |
|---|---|
| read / write / edit / patch | Files. `patch` applies exact old→new edits atomically (cheap, safe). |
| glob / grep | Search. |
| shell | Commands (permission-gated). |
| todo | Running UI task list. |
| memory | Durable per-project facts in `.voxai/memory.json` (add/list/search/forget). |
| rag | Keyword retrieval over large files (>12k chars), chunk sidecars under `.voxai/rag/`. |
| worktree | Git worktree isolation (create/status/merge/discard) under `.voxai/wt/`. |
| web_fetch | https-only research fetch (permission-gated). |
| lsp | Fast diagnostics: tsc / `node --check` / py_compile / JSON.parse. |
| snapshot | Session + workspace snapshots (create/list/restore) in userData. |
| node_repl | Pure-JS VM sandbox (no fs/network/require) for quick code checks. |
| mcp_list_tools / mcp_call | Model Context Protocol stdio client (configure servers in settings `mcpServers`). |
| skills_list / skill_load | Load skills from `~/.codex/skills` + `~/.claude/skills` (Cloudflare, sandbox, wrangler, …). |
| stat / mkdir / move / remove / search | Filesystem parity (AI_GUI workspace_* equivalents). |
| doc_rag | Document RAG: txt/md/pdf/docx/xlsx → chunk → keyword retrieve (dependency-free). |
| spawn_agent | Nested sub-agent for parallel exploration (own sub-session, isolated, persisted). |
| browser_open / browser_act / browser_screenshot | Drive a hidden Electron BrowserWindow (runtime-gated). |
| cu_launch / cu_state / cu_click / cu_type / cu_press / cu_scroll / cu_screenshot / cu_list | Computer Use: read the live screen (text + indexed elements + screenshot streamed to the UI) and act on it — persistent Chrome/Edge via CDP, plus native Windows window control (Win32/.NET). |
| spawn_agent / spawn_parallel | Sub-agents now stream LIVE events into the main thread as collapsible inline cards (Claude/Codex style) — no separate tab needed. |
| Plan mode (chip toggle) | When ON, the agent explores first, presents a step-by-step plan, and calls ask_confirm — mutating tools are gated until you approve (Claude/Codex plan mode). |
| sandbox_status | Report access level, per-tool auto/prompt policy, worktree isolation. |
| artifact_publish | Publish reviewable artifacts (changed_file/log/screenshot/validation) with hash + UI event. |

## Concurrency & cost
- Multiple sessions run in parallel; each owns its stream/run-card/token state.
- Header shows session COST / TOKENS / $per-1M (Goose-style: catalog pricing
  fallback when OpenRouter omits real cost).

## Roadmap / ideas
- MCP client for external servers (stub exists).
- Real git diff tab + preview pane from the original Forge concept.
- Cloudflare skill integration (your installed skills are already in
  `~/.claude/skills` / `~/.codex/skills`).