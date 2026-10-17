# Changes

## 0.2.87 (2026-10-18)

Settings > Appearance: themes, accent colours, text size. Settings > Computer use: on/off switches and a status check. Attachments show as chips and thumbnails. Linux desktop control and preview fixes; Mac groundwork.

## 0.2.86 (2026-10-18)

Several projects at once in one window: going back to a project whose run is still going no longer breaks it, and Stop ends a run waiting on an approval. The balance counts down as runs spend. Side by side, the session list opens into the pane you are working in. Releases now come from the main VoxAI Coder project.

## 0.2.85 (2026-10-17)

Spends less on every model: one fixed prompt per session so the provider cache keeps hitting, only the memory facts that matter, the thinking level shown with its cost, long requests kept under GPT and Grok price jumps, stale reads and old screenshots left out, and a stop when the model goes in circles. Edits that match more than one place are refused. The model picker shows what a message costs you. Updates download with progress in Settings > Account.

## 0.2.84 (2026-10-17)

Settings redone page by page: saved keys shown as themselves, sortable usage, Add credits, model pickers by company, a picture of the context, Memory with Undo, and Skills grouped with New skill. Local models: download GGUF models from Hugging Face, checked against their checksums, and see which fit your card. A new Apps (MCP) page to add and test MCP servers. Finished turns fold to their answer, answers stream formatted, queued messages send after a Stop, long sessions keep what you asked, and New update ready can be dismissed.

## 0.2.83 (2026-10-04)

Batch models are no longer offered: OpenRouter answers them only within 24 hours, so they failed in chat. Models with a flex tier (OpenAI, Google) get a Cheaper, slower switch in the model picker: the batch price, live. Replies are slower; when flex is busy the normal price applies instead of an error. Sessions saved with a batch model move to the same model on flex.

## 0.2.82 (2026-10-03)

New: Review changes (the ± button) to see the diff hunk by hunk, put changes back, comment on lines for the agent, write the commit message, commit, push, open a pull request and fix failing checks. Type @ to send files with your message. A terminal panel (>_) beside the chat. Fixes: queued messages go to the right session, safer shell approvals, sessions that cannot be corrupted, Stop works while a local model loads.

## 0.2.81 (2026-10-03)

Steering works mid-run: a message you steer in while VoxAI is working is read at its next step, shows as a Steering conversation bubble, and leaves the queue. Queued messages still send if a run's end was missed. Linux: each release gets a VoxAI-Coder-<version>-Linux.sh installer next to the AppImage.

## 0.2.80 (2026-09-28)

Screenshots now work while VoxAI Coder is minimised, so it can still check what it builds. The model picker shows how fast each local model runs on your PC and suggests the biggest one as the Team coder. Local models no longer fail when a long conversation outgrows their memory; older turns are summarised and the request is sent again.

## 0.2.79 (2026-09-28)

Local models: bigger mixture-of-experts coders such as Qwen3-Coder-30B-A3B now load well on an 8 GB card, with part of the model in RAM, and are tuned for your PC. Local Team coders get 30 minutes a step. The slow-PC warning no longer fires by mistake while a prompt is read, and only a truly starved local coder is stopped. The graphics card is found reliably at startup.

## 0.2.78 (2026-09-28)

Local models: if another program slows the PC so much that the local model crawls, VoxAI now says so within half a minute instead of waiting silently. A Team coder on a crawling local model stops after 2 minutes and the planner tells you why, instead of trying again for half an hour.

## 0.2.77 (2026-09-28)

Local models: run GGUF models on your own PC for free. Settings > Local models installs a llama.cpp engine, finds your GPU and tunes how much of the model it holds, and remembers it. Local models appear in the picker at $0 and can be the Team coder. They save their work to files instead of pasting code in the chat.

## 0.2.76 (2026-09-28)

Auto: new safety rules stop and ask before deploys, cloud changes, remote databases, ssh, running downloaded programs or scripts from outside the project, wiping drives, and changing machine-wide tool settings. Settings > Account can now list every key on your OpenRouter account and what each has spent. Updates keep a log, and Restart says when it can't go ahead. Text that arrived while the window was covered shows at once when you come back. Team planners spend fewer turns on bookkeeping.

## 0.2.75 (2026-09-27)

Team: the planner hands out small steps and keeps working with the same coder instead of starting a fresh one each time, so the coder keeps what it has read. The coder asks when it is stuck instead of guessing, and tests with a short run-through.

## 0.2.74 (2026-09-27)

Team: the planner hands off, trusts the coder's report and takes one final look, so builds cost less; if the coder can't see images, the planner does the looking. Coders now see their own screenshots. Auto: the main model decides anything the risk rules don't flag, with no extra checker call. A session moved back from side-by-side shows its full history. A model request that stops responding is retried after 3 minutes instead of waiting forever.

## 0.2.73 (2026-09-27)

Team: the coder now has the browser. It opens and uses what it builds (clicks, plays) and fixes what looks or plays wrong before reporting; if it hands back a page or game it never looked at, the planner sends it back.

## 0.2.72 (2026-09-27)

Models OpenRouter won't run in VoxAI are greyed out in the model picker with the reason. Recent models leaves out ones that can't do the job. Pop-up messages sit over the chat instead of under the preview. Team: when the planner keeps trying to do the coder's work, it is told more plainly to hand it off.

## 0.2.71 (2026-09-27)

Team: the planner hands the writing and the browser testing to the cheaper coder, so Team costs less. Free models: when one is busy or out of its daily allowance you get one-click Try again, the paid version, or another free model; today's free requests show beside your balance. Browsers left open in the background stop using the CPU when nothing is using them. Dialogs and menus are no longer covered by the preview or side-by-side sessions. The preview now shows a new session's page straight away.

## 0.2.70 (2026-09-27)

Free models: a busy free model is no longer reported as out of its daily limit, free models get longer retries, a refusal of one model is no longer called a bad API key, and more free providers accept VoxAI's requests.

## 0.2.69 (2026-09-27)

Agent browsers keep running while out of sight: a game being tested in a session's browser no longer freezes when that browser isn't the one shown in the preview.

## 0.2.68 (2026-09-27)

Each session now has its own browser, so agents working side by side no longer fight over one page, and the preview has a tab for each session's page. While a planner waits on its coders, you see what they are doing. Runs started in a split pane show as running everywhere.

## 0.2.67 (2026-09-27)

Fixed empty 'Try it / Not now' buttons showing during runs. All Grok models are now in one group in the model picker (OpenRouter labels them SpaceXAI and xAI). Every request starts about 1,100 tokens smaller. Auto now always asks before clicks or typing that buy, post, sign in, delete accounts or data, uninstall, accept terms or type a password.

## 0.2.66 (2026-09-27)

Team now picks its coder from the model picker: the same owners and search, showing every model that can code for under $3 per 1M tokens in and out. Anonymous 'stealth' models and anything free now count as data-sharing, with the same disclaimer.

## 0.2.65 (2026-09-27)

Team: when you use an expensive model (Opus, Sonnet, GPT-5...), a Team chip lets it plan and review while a cheap model writes the code. After a costly run a quiet hint shows what it would have saved. Data-sharing models (like Meta's Muse Spark Contributor and free models) are now marked, and choosing one first shows 'Choosing this model shares your coding data' and asks once per project. OpenRouter's privacy refusals and free daily limits are explained in plain words.

## 0.2.64 (2026-09-27)

Auto now only stops you for real risk: ordinary project work (installs, scripts, builds, local git, cleaning build output, localhost) just runs, and known harm (secrets, global installs, system settings, pushing code out, throwing work away) always asks with the reason. Saying no covers that one attempt. New setting: keep Claude's cache for an hour. The split layout comes back after a restart, and the first time VoxAI hides to the tray it tells you where it went.

## 0.2.63 (2026-09-27)

The corner card now looks like the app's own approval box, with less on it: what it wants to do and where, and the answers. Approvals get Deny / Always approve / Approve; questions get Yes / No, or up to three choices as buttons, answered right on the card.

## 0.2.62 (2026-09-27)

Under each finished run, where the money went: fresh input, cached input, cache writes, output (with thinking) and extras like Auto checks. Auto's checks now run on a cheap model (Settings > Permissions). Claude sessions left idle past their 5-minute cache say what the next message will cost, with Summarise first. Notifications are a VoxAI card in the corner (like AI Account Hub) with Allow once / Deny / Open; Windows' own is still an option.

## 0.2.61 (2026-09-27)

Drag a session and a map of the layout covers the panes: drop it on the spot you want (the others fill the rest), on the main pane to open it there, or with four open on a pane to swap it. The main pane's session can no longer also open in a pane. The agent's browser and the preview's Reload always get the latest files instead of a cached copy.

## 0.2.60 (2026-09-27)

Sessions side by side: drag a session from the list into the chat for 2, 3 or 4 panes (the preview stays off while split). Notifications when a session needs you: a Windows notification with Allow / Deny / Open, a taskbar badge and flash, and optional minimize or close to the tray. Skills for GitHub, GitLab, Codeberg and CodeRook. The session folder in the header opens in File Explorer.

## 0.2.59 (2026-09-27)

In Auto, the agent clicks around its own app in the preview without asking; on websites and the desktop Auto's check decides and only risky actions ask. Every finished run now ends with how long it took, what it cost and its tokens.

## 0.2.58 (2026-09-27)

The CodeRook page now has a download link for the installer, so VoxAI Coder can be installed on another PC straight from the website.

## 0.2.57 (2026-09-27)

Slash commands with a / menu: /review, /init (writes AGENTS.md), /rewind (undo the last run's file changes) and /loop. The agent's questions now appear one at a time in the input box. The conversation is cleaner: the agent's text stays where it wrote it and each action is its own line. Models that can't see images say so. DeepSeek V4.1 Flash is the new default model.

## 0.2.56 (2026-09-26)

The agent can stop the app it is testing (with a short pause after) without being wrongly held up.

## 0.2.55 (2026-09-26)

Ending programs by code (like os.kill) now asks too, prompts name the real program and tell the agent it is not its app, and a refused kill stays refused for the session.

## 0.2.54 (2026-09-26)

When the model's reply is cut off at its output limit (for example while planning a whole app at once), it is told what happened and carries on in smaller steps instead of stopping.

## 0.2.53 (2026-09-26)

Screenshots of VoxAI Coder's own window now show the app itself, not whatever is covering it. Sub-agent approvals lead with the task instead of setup text.

## 0.2.52 (2026-09-26)

Sub-agents now ask you in the session's approval box whenever your mode says to ask (they used to approve their own commands and edits). Workers from the Sub-agents panel too. Several requests at once now queue instead of replacing each other.

## 0.2.51 (2026-09-26)

/goal: type /goal and what done means, and it keeps working until a separate check of the tool results says it is met (Stop pauses, continue resumes, Limit per goal). Ending programs by name always asks first, in every mode. Models that cannot see get screenshots described. Auto and Full access no longer pause every 60 turns.

## 0.2.50 (2026-09-26)

Delete several sessions at once: Ctrl+click, Shift+click, or the Select button, or right-click a project to delete all its sessions (its folder and files are never touched). Deleting a session that is still running now stops it first, and it stays deleted. Snapshots go to the Recycle Bin with their session.

## 0.2.49 (2026-09-26)

Esc now only stops desktop control while the agent is using your keyboard and mouse and for 6 seconds after, instead of taking Esc from every app for 30 seconds. Desktop steps are always labelled as desktop steps. Corrected the built-in skills: 'Sign in with Google' works in the preview.

## 0.2.48 (2026-09-26)

Desktop safety, tested for real: moving the mouse now reliably pauses the agent (even after 'Always'), and it carries on once you say so. It only clicks where the app is really on top and on screen, so a click never lands under the taskbar, on another window or somewhere else on your screen. Desktop clicks are always asked about as desktop actions.

## 0.2.47 (2026-09-26)

Desktop fixes: the agent can read what a window shows (like Calculator's display), not only its buttons. Its own Esc key reaches the app instead of stopping it. Store apps are named properly in approvals. Starting any program now asks you first.

## 0.2.46 (2026-09-26)

The agent can now use apps on your Windows desktop the way Byte does: it names a window, reads its buttons and boxes as a numbered list, and clicks or types into them. Typing is exact, in any language. Every desktop action asks you first, naming the app and what it will do, with 'Always for <app>'. Press Esc or move the mouse to stop it. It never types into password boxes and never looks into password managers or private browser windows. A new built-in computer-use skill teaches it how.

## 0.2.45 (2026-09-26)

The agent now uses skills: it sees what each skill is for at the start of every run and loads the right one before planning or acting. Skills load whole, with their reference files. New built-in skills for using the preview browser and for setting up outside services safely. Settings has a Skills page listing them, with a button to open your own skills folder.

## 0.2.44 (2026-09-26)

The preview is now a browser you can use: type an address or a search, links meant for a new tab open in it, and sign-in pop-ups open as a window over the app. When the agent clicks or types on a real website it asks you first, even in Auto, with 'Always on <site>' to allow that site for the session.

## 0.2.43 (2026-09-26)

The agent can screenshot one window, even when other windows cover it, and finds windows by title or app name. Two-monitor desktop captures are readable again. A browser screenshot with the preview closed fails at once instead of waiting 10 seconds. Screen captures no longer pile up in the Temp folder.

## 0.2.42 (2026-09-26)

Questions and approvals now wait until you answer instead of timing out. Sessions waiting on you are marked 'needs you' in the sidebar, and a question the app closed on opens by itself at start.

## 0.2.41 (2026-09-26)

A question the agent is waiting on now survives a window reload or an app restart; answering it after a restart carries the run on. Sidebar search finds words inside conversations. Deleting a conversation also removes its sub-agent sessions. Screenshots take about half the space. The Copy button stays put on wide code.

## 0.2.40 (2026-09-26)

MCP servers now work. Safer git worktree merges. The agent knows today's date, so searches for current information are accurate.

## 0.2.39 (2026-09-26)

Confirmations work like questions: Esc dismisses them, and you can type yes, no, or what to do instead. Clearer records of what you answered.

## 0.2.38 (2026-09-25)

The agent now asks you about choices it is unsure of, Claude Code style: several questions at once, each choice explained, pick one or several, or type your own answer. Redesigned question cards, with keyboard shortcuts (1-9 to pick, Enter to submit, Esc to skip).

## 0.2.37 (2026-09-25)

New: Settings > Memory to see and remove what the agent remembers. Esc stops a running answer. Copy buttons on code. Keyboard shortcuts (see Settings > Keyboard), and Ctrl+V pastes text, images or files from anywhere. Extra protection against injected scripts.

## 0.2.36 (2026-09-25)

Each session keeps its own half-typed message. The Send and Stop button stays visible in a small window with the preview open.

## 0.2.35 (2026-09-25)

Typing a message on the start screen and pressing Send now works. Steering a queued message always applies to the one you picked.

## 0.2.34 (2026-09-25)

Reopened sessions show the screenshots the agent took. Closing and reopening the preview brings back the page it was showing.

## 0.2.33 (2026-09-25)

If the connection drops mid-answer, what arrived is kept and you can send continue. Empty answers are retried automatically.

## 0.2.32 (2026-09-25)

OpenRouter problems (no credits, key not accepted, rate limits, busy providers) are now explained plainly, and brief outages are retried automatically.

## 0.2.31 (2026-09-25)

Restoring a saved snapshot now asks first when you've chosen Ask first.

## 0.2.30 (2026-09-25)

Small fixes to the agent's JavaScript scratchpad and file search.

## 0.2.29 (2026-09-25)

If an update ever fails to install when you press Restart, the app now tells you and downloads it again.

## 0.2.28 (2026-09-25)

Fixes the 0.2.27 update, whose installer was incomplete. Includes the 0.2.27 changes: Python test counts and clearer labels.

## 0.2.27 (2026-09-25)

Python test runs now show how many passed or failed. Files the agent keeps a copy of are no longer labelled as published.

## 0.2.26 (2026-09-25)

Files the agent deletes now go to the Recycle Bin, so they can be restored. Searches return the right results more often.

## 0.2.25 (2026-09-25)

Commands that print a lot (big test runs, builds) now finish with their real result instead of failing. The agent reads a file before replacing it, so nothing is overwritten unseen.

## 0.2.24 (2026-09-25)

Edits keep Windows line endings, so files no longer end up with mixed endings. File and folder names with accents now show correctly in command output.

## 0.2.23 (2026-09-25)

Asking for a local server no longer hangs the run: it starts in the background and the agent carries on. Anything the agent left running now stops when you close the app.

## 0.2.22 (2026-09-25)

The microphone button now tells you voice input isn't available here and suggests Windows voice typing (Win+H). Esc closes the Usage window.

## 0.2.21 (2026-09-25)

New session now checks that the folder exists and tells you if it doesn't. Drop or paste an image to attach it. Esc closes the New session dialog.

## 0.2.20 (2026-09-25)

Security fix: a message waiting in the queue could run pasted HTML inside the app. Queued messages are now always shown as plain text.

## 0.2.19 (2026-09-25)

Security fix: a link in an answer could replace the app with a website that then had access to the app. Links now open in your browser. Export saves the session you right-clicked and tells you where; Delete moves a session to the Recycle Bin.

## 0.2.18 (2026-09-25)

No more empty gap between a step and the answer. File reads count lines the way an editor does: a one-line file shows as 1 line.

## 0.2.17 (2026-09-25)

Page reads now use the preview you're looking at, and skip the screenshot while the window is minimised instead of waiting. When OpenRouter can't be reached, the notice says so and what to check. The sub-agent time limit in Settings can no longer be raised by the model.

## 0.2.16 (2026-09-25)

Stop now also ends the command the agent was running, including anything it started, and a stopped step reads Stopped.

## 0.2.15 (2026-09-25)

Stop now ends a run immediately, even while an action is stuck, and browser actions give up after a time limit instead of waiting forever.

## 0.2.14 (2026-09-25)

After an update, the downloaded installer is cleared within a couple of minutes instead of waiting for the next launch.

## 0.2.13 (2026-09-25)

Frees the space used by old update downloads: the app now removes every installer it has already installed when it starts.

## 0.2.12 (2026-09-25)

Reopened sessions show each step's own results, and long sessions can switch to any model safely. The type checker works on Windows and says whether it found errors. A run that stopped at a limit still says so when you reopen the session.

## 0.2.11 (2026-09-25)

Snapshots now save your project's files and restoring one puts them back (it asks first, like any change). Clearer wording for snapshot, worktree, JavaScript and export steps.

## 0.2.10 (2026-09-25)

Steering a queued message now actually reaches the agent. The usage window loads your per-model spend, lists the biggest first, and opens above Settings.

## 0.2.9 (2026-09-25)

When a run stops at its spend or turn limit, or something goes wrong, you now get a clear notice with Continue and Change the limit buttons. A message that could not be sent says so and goes back in the box. Settings shows the real version.

## 0.2.8 (2026-09-25)

Ctrl+N, Ctrl+O and the File menu now work. The changes strip updates while the agent edits and after each run. Fetched pages, published artifacts and background agents now appear as tidy rows, and memory rows read plainly.

## 0.2.7 (2026-09-25)

The preview offer is now a tidy row with Open and Always, says Opened when the page is already showing, and stays visible after the run. Files in your project are named plainly (hello.html) instead of long file addresses.

## 0.2.6 (2026-09-25)

Plan mode no longer asks permission for changes it would hold back, and lets read-only commands run while planning. Approval buttons say exactly what Always covers, and actions you denied read plainly.

## 0.2.5 (2026-09-25)

When the agent asks you something with a set of choices, they now appear as buttons. An answered question's row shows your answer instead of staying on Asking.

## 0.2.4 (2026-09-25)

Frees 110 MB after each update: the app removes an update's download once it has been installed.

## 0.2.3 (2026-09-25)

The build folder no longer fills up with old installers, and the app checks for updates once at launch instead of twice.

## 0.2.2 (2026-09-25)

Updates are found sooner (every 30 minutes and when you return to the window) and retried after a failed check. Only one copy of the app runs at a time. Settings shows when it last checked.

## 0.2.1 (2026-09-25)

Progress-notes rows now read plainly: 'Saved progress notes' and the task, instead of the tool's internal wording.

## 0.2.0 (2026-09-25)

VoxAI Coder now updates itself from CodeRook: it checks for signed releases, downloads them in the background and offers to restart.

