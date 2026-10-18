# VoxAI Coder on macOS: porting notes

```
 ┌───────────────────────────────────────────────────────────────────────┐
 │  Status: groundwork done, not yet built or run on a Mac.              │
 │  Everything platform-specific already has a macOS branch; what is     │
 │  left is building, signing, testing, and one optional backend.        │
 └───────────────────────────────────────────────────────────────────────┘
```

This page is for whoever builds VoxAI Coder on a Mac for the first time. It lists what is
already in place, what is still missing, and how to build and check it. Linux is covered in
[LINUX.md](LINUX.md) and [LINUX-BUILD.md](../LINUX-BUILD.md).

---

## ▓▒░ What is already Mac-aware

| Area | Where | What it does on macOS |
|---|---|---|
| Window | `src/main/main.js` createWindow | `titleBarStyle: 'hiddenInset'` with the traffic lights at (14, 11); the page leaves 80 px for them and hides its own window buttons (`html[data-platform="darwin"]`) |
| Menu bar | `src/main/main.js` createWindow | the app menu, **Edit** (without it Cmd+C / Cmd+V / Cmd+A do nothing in text fields), View, Window, Help |
| Shortcuts | `src/renderer/index.html` `SHORTCUTS`, `MOD`, `KEY_LABEL` | Cmd instead of Ctrl for the app's own shortcuts, shown as ⌘ ⇧ ⌥ in Settings > Keyboard and on the New session button; Ctrl+Tab stays Ctrl |
| Dock | `src/main/main.js` | closing the window keeps the app in the Dock; clicking the Dock icon opens a window again (`activate`) |
| Badge | `src/main/attention.js` | sessions waiting for you show as a number on the Dock icon (`app.setBadgeCount`); a waiting approval bounces the icon (`flashFrame`) |
| Keys | Electron `safeStorage` | API keys are kept in the macOS Keychain |
| Shell | `src/backend/tools/index.js`, `agent.js` | the agent's commands run in `/bin/sh`, and the prompt tells the model it is on macOS |
| Terminal panel | `src/main/terminal.js` | your `$SHELL` (zsh by default) as a login shell |
| Local models | `src/main/local-engine.js` | llama.cpp's macOS build (Apple Silicon and Intel, Metal on the GPU), pinned and checked by SHA-256, kept in `~/Library/Application Support/voxai-coder-engine`, libraries found through `DYLD_LIBRARY_PATH`, cores from `sysctl hw.physicalcpu` |
| Agent's browser | `src/backend/cu/cdp.js` | Chrome, Edge, Brave or Chromium from `/Applications` |
| Dictation hint | `src/renderer/index.html` | points to macOS dictation when the mic cannot work |
| Updates | `src/main/updater.js` | off, with a reason in Settings > Account (see below) |
| Build | `voxai-coder/package.json` `build.mac`, `npm run dist:mac` | `.dmg` and `.zip`, Apple Silicon and Intel, hardened runtime, `resources/entitlements.mac.plist`, the icon from `resources/icon-1024.png` |

## ▓▒░ What is still missing

1. **Signing and notarisation.** An unsigned app opens only after right-click ▸ Open (or
   `xattr -dr com.apple.quarantine "/Applications/VoxAI Coder.app"`). For a normal install it
   needs a Developer ID Application certificate and notarisation: set `CSC_LINK` /
   `CSC_KEY_PASSWORD` and `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`, and add
   `"notarize": true` to `build.mac`. The entitlements are already listed.
2. **Updates.** Squirrel.Mac installs only a signed app. Once the build is signed:
   - publish `VoxAI-Coder-<v>-mac-<arch>.zip` to the release (CodeRook's feed already serves
     `latest-mac.yml`);
   - sign an `update-mac.json` beside it in `scripts/release.js` (as `--linux` does for
     `update-linux.json`);
   - in `src/main/updater.js` pick that manifest and `/\.zip$/` on `darwin`, and drop the
     `mac` exception that keeps updates off.
3. **Desktop control** (the agent using other apps). There is no macOS backend:
   `src/backend/cu/platform.js` loads the Windows modules there, which report themselves
   unavailable, so the agent says so. A backend is three files with the same surface as
   `win-input.js`, `native.js` and `uia.js`:
   - **mac-input**: mouse and keys through CGEvent (koffi can call CoreGraphics the way
     `win-input.js` calls user32), window focus through `NSRunningApplication`;
   - **mac-native**: screenshots with `screencapture -x`, windows from `CGWindowListCopyWindowInfo`;
   - **mac-uia**: the element tree from the Accessibility API (`AXUIElement`).

   It needs the Accessibility and Screen Recording permissions (System Settings ▸ Privacy &
   Security), which the app should ask for and explain. Then add `darwin` to `platform.js`.
4. **The release script** builds and publishes Windows and Linux only; `--mac` would follow
   the `--linux` path.

## ▓▒░ Building

On a Mac with Node 20 or newer and Xcode's command line tools (`xcode-select --install`,
which node-pty needs to compile):

```bash
cd voxai-coder
npm ci
npm test            # must pass; the tests know which system they run on
npm start           # run it from source
npm run dist:mac    # release/VoxAI-Coder-<v>-mac-arm64.dmg and -x64, plus .zip
```

Building for Intel on Apple Silicon works; signing needs the certificate in the keychain.

## ▓▒░ Checking a Mac build

- [ ] The traffic lights sit in the title bar, left of the VoxAI mark; nothing overlaps.
- [ ] Cmd+C, Cmd+V, Cmd+A and Cmd+Z work in the message box and in Settings fields.
- [ ] Cmd+N (new session), Cmd+K (search), Cmd+, (Settings), Cmd+L, Cmd+\ work;
      Settings ▸ Keyboard shows ⌘.
- [ ] Closing the window leaves the app in the Dock; clicking it brings the window back.
- [ ] A session waiting for an approval shows a Dock badge.
- [ ] Keys saved in Settings ▸ Account survive a restart ("Saved in the system keychain").
- [ ] A run's shell commands work (`ls`, `npm test`); the terminal panel opens zsh.
- [ ] The preview shows a page the agent opens, and follows its navigation.
- [ ] Attach a picture (button, drag and drop, paste) and a file; both show as chips, and in
      the sent message.
- [ ] Settings ▸ Local models: the engine downloads, the card shows as Metal, a small GGUF runs.
- [ ] Settings ▸ Account says this build does not update itself.
