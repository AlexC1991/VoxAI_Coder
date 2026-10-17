# VoxAI Coder on Linux

```
 ┌─────────────────────────────────────────────────────────────────────┐
 │  VoxAI Coder for Linux: an AppImage for 64-bit Intel/AMD (x86_64).  │
 │  Installs for you alone under ~/.local, no sudo, updates itself.    │
 └─────────────────────────────────────────────────────────────────────┘
```

This page covers installing, using and fixing VoxAI Coder on Linux. Building it from
source and publishing a Linux release are in [LINUX-BUILD.md](../LINUX-BUILD.md).

[Install](#-install) · [First run](#-first-run) · [Where things are](#-where-things-are) ·
[What is different on Linux](#-what-is-different-on-linux) · [Updates](#-updates) ·
[Uninstall](#-uninstall) · [Troubleshooting](#-troubleshooting)

---

## ▓▒░ What you need

| | |
|---|---|
| **CPU** | 64-bit Intel or AMD (`uname -m` says `x86_64`). ARM is not built yet. |
| **FUSE 2** | AppImages start through it. See [the AppImage does not start](#the-appimage-does-not-start). |
| **A keyring** | GNOME Keyring or KWallet, so your API keys are stored encrypted. See [keys](#the-keys-are-not-stored-in-a-keyring). |
| **curl or wget** | For the installer script. |
| **Optional** | `git` (Review changes, commits), `gh` / `glab` (pull requests), Node.js and Python 3 for the projects you build, Chrome / Chromium / Edge / Brave for the agent's own browser. |

Most desktop distributions (Ubuntu, Debian, Fedora, Mint, Pop!_OS, Arch, openSUSE) already
have everything but FUSE 2.

---

## ▓▒░ Install

### ── With the installer script (recommended)

Download `VoxAI-Coder-<version>-Linux.sh` from the
[releases project on CodeRook](https://coderook.com/batty-251/voxai-coder-releases), then:

```bash
bash VoxAI-Coder-0.2.85-Linux.sh
```

It downloads the AppImage for that version, checks its SHA-512, installs it, adds VoxAI Coder
to your applications menu and starts it. Other options:

```bash
bash VoxAI-Coder-0.2.85-Linux.sh --no-start    # install, do not start
bash VoxAI-Coder-0.2.85-Linux.sh --uninstall   # remove the app (your data stays)
```

The script tells you if FUSE 2 is missing, and if `~/.local/bin` is not on your `PATH`.

The Linux build of a version is made after the Windows one. If the script's link does not
work yet, that version's Linux build is not out; try again later or use the previous
version, which then updates itself.

### ── Or run the AppImage directly

```bash
chmod +x VoxAI-Coder-0.2.85.AppImage
./VoxAI-Coder-0.2.85.AppImage
```

It runs from wherever you put it, without a menu entry. It still updates itself.

---

## ▓▒░ First run

```
 1 ▸ Settings ▸ Account     paste your OpenRouter key, Save
 2 ▸ the chat bar           pick a model and a project folder
 3 ▸ type what you want     and send
```

Start it from the applications menu, or with `voxai-coder` in a terminal.

---

## ▓▒░ Where things are

```
~/.local/share/voxai-coder/VoxAI-Coder.AppImage    the app
~/.local/share/voxai-coder/icon.png                its menu icon
~/.local/share/applications/voxai-coder.desktop    the menu entry
~/.local/bin/voxai-coder                           the terminal command (a link to the app)

~/.config/voxai-coder/                             your data: kept on uninstall
├── voxai-settings.json                            settings; keys stored encrypted
├── sessions/                                      every session, one .jsonl file each
├── skills/                                        your own skills (Settings ▸ Skills)
└── checkpoints/                                   file snapshots for /rewind

~/.cache/voxai-coder-updater/                      update downloads

<your project>/.voxai/                             project memory, project skills, notes
<your project>/AGENTS.md                           what /init writes; every session reads it
```

`$XDG_DATA_HOME` and `$XDG_CACHE_HOME` are used instead of `~/.local/share` and `~/.cache`
when they are set. Skills in `~/.claude/skills` and `~/.codex/skills` are picked up too.

---

## ▓▒░ What is different on Linux

| | Windows | Linux |
|---|---|---|
| **The agent's shell** | `cmd.exe` | `/bin/sh` |
| **The terminal panel** (`>_`) | PowerShell | your `$SHELL`, as a login shell |
| **`sudo` and password prompts** | n/a | refused in the agent's shell; it runs them in the terminal panel, where you type the password |
| **Models on this PC** | yes (llama.cpp, Vulkan) | not yet: the engine is the Windows build. Settings ▸ Local models says so |
| **Computer use: desktop apps** | yes | not yet (Windows UI Automation) |
| **Computer use: the browser** | Chrome or Edge | Chrome, Chromium, Edge or Brave, found in `/usr/bin` or `/snap/bin` |
| **The preview pane** | yes | yes |
| **MCP apps** | all | all but *Windows apps* |
| **Voice input** (mic button) | Win+H dictation | not available: Electron has no speech service |
| **Tray icon** | yes | needs a tray: on GNOME, the AppIndicator extension |
| **Updates** | the installer | the AppImage |
| **Keys** | Windows DPAPI | your keyring (libsecret: GNOME Keyring or KWallet) |

Everything else (models on OpenRouter, Team mode, sub-agents, skills, memory, `/goal`,
Review changes, cost tracking and limits) works the same.

---

## ▓▒░ Updates

The AppImage checks for updates when it opens and when you come back to it, downloads new
versions in the background, and offers to restart when one is ready (in the sidebar, or in
Settings ▸ Account). Each update is checked against the release's signed
`update-linux.json`: the signature, the size and the SHA-512 must all match, or it is not
installed.

Only the AppImage updates itself. A copy built from source says *Only the AppImage updates
itself on Linux.* in Settings ▸ Account.

---

## ▓▒░ Uninstall

```bash
bash VoxAI-Coder-0.2.85-Linux.sh --uninstall   # any version's script will do
```

That removes the app, its menu entry and the `voxai-coder` command. Your sessions and
settings stay in `~/.config/voxai-coder`; to remove those too:

```bash
rm -rf ~/.config/voxai-coder ~/.cache/voxai-coder-updater
```

Without the script, delete the four files listed under *the app* in
[Where things are](#-where-things-are).

---

## ▓▒░ Troubleshooting

### The AppImage does not start

Nothing happens, or a terminal shows *AppImages require FUSE to run* or
*dlopen(): error loading libfuse.so.2*. Install FUSE 2:

```bash
sudo apt install libfuse2        # Debian, Ubuntu up to 23.10, Mint
sudo apt install libfuse2t64     # Ubuntu 24.04 and later
sudo dnf install fuse-libs       # Fedora
sudo pacman -S fuse2             # Arch
```

### It closes at once with a sandbox message

Run it from a terminal (`voxai-coder`). If you see *The SUID sandbox helper binary was found,
but is not configured correctly* or a *Failed to move to new namespace* error, your system
blocks the user namespaces Chromium's sandbox uses. Ubuntu 23.10 and later do this through
AppArmor.

To confirm that is the cause, start it once without the sandbox:

```bash
voxai-coder --no-sandbox
```

If that opens, there are two ways to fix it, each with a cost:

- Allow unprivileged user namespaces again, for the whole system:

  ```bash
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
  ```

  This lasts until you restart. To keep it, put the same setting in a file under
  `/etc/sysctl.d/`. It undoes a hardening Ubuntu turned on deliberately.
- Keep using `--no-sandbox`, by adding it to the `Exec=` line in
  `~/.local/share/applications/voxai-coder.desktop`. That turns off the sandbox around the
  app's own pages and the preview, so only do it if you trust what you open in the preview.

### The keys are not stored in a keyring

Electron stores your keys through libsecret. Without a running keyring it falls back to a
key built into Electron, which protects them far less. Install and unlock one:

```bash
sudo apt install gnome-keyring   # GNOME, Cinnamon, MATE, XFCE
sudo apt install kwalletmanager  # KDE (KWallet usually comes with Plasma)
```

Then log out and in again, and save the keys once more in Settings ▸ Account.

### `voxai-coder: command not found`

`~/.local/bin` is not on your `PATH`. Add this to `~/.bashrc` (or `~/.zshrc`) and open a new
terminal:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

The menu entry works without it.

### The terminal panel is empty, or the wrong shell

It starts `$SHELL` (bash or zsh as a login shell), or `/bin/bash` when `$SHELL` is not set.
Check `echo $SHELL` in a terminal; `chsh -s /bin/bash` changes it.

### The agent's browser does not open

Computer use drives a real Chrome-family browser. Install one of Google Chrome, Chromium,
Microsoft Edge or Brave in the usual place (`/usr/bin/google-chrome`, `/usr/bin/chromium`,
`/snap/bin/chromium`, ...). A Flatpak-only browser is not found. The preview pane needs
nothing extra.

### No tray icon

Only needed for *minimise / close to tray*. On GNOME, install the
*AppIndicator and KStatusNotifierItem Support* extension; KDE, XFCE and Cinnamon have a tray.

### The installer says the checksum differs

The download was cut short or changed on the way. Run the script again. If it keeps
happening, download the AppImage directly from the releases project and compare:

```bash
sha512sum VoxAI-Coder-0.2.85.AppImage
```

with the `SHA512=` line near the top of the `.sh` script.

### Something else

Start it from a terminal with `voxai-coder` and read what it prints, then
[open an issue on GitHub](https://github.com/AlexC1991/VoxAI_Coder/issues) with that output,
your distribution and version (`cat /etc/os-release`), and the app version
(Settings ▸ Account).
