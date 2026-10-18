# Building VoxAI Coder on Linux

```
 Windows                                  Linux
 ─────────────────────────────            ─────────────────────────────────────
 bump version, npm run dist        ──▶    cbx get / git pull  (same version)
 npm run release -- --notes "…"           npm ci, npm test, npm run dist:linux
   publishes v<version> with the   ──▶    npm run release -- --linux
   .exe and update.json                     adds the AppImage, the .sh and
                                            update-linux.json to that release
```

This page is for building VoxAI Coder from source on Linux and adding the Linux build to a
release. Using the app on Linux is covered in [docs/LINUX.md](docs/LINUX.md).

Every release is made on Windows first. The Linux build then joins **the same release**:
one version carries both installers, and each platform checks its own signed manifest
(`update.json` on Windows, `update-linux.json` on Linux). The version to build is whatever
`voxai-coder/package.json` says.

---

## ▓▒░ 0. Build in your own copy

If Windows and Linux share a disk, do not build in the Windows working copy
(`A:\Github\VoxAI_Coder`):

- `npm ci` would replace `node_modules` (Electron, node-pty) with Linux builds and break
  the Windows copy;
- NTFS is a poor place to build an AppImage (permissions, symlinks).

Use a separate copy in your Linux home folder.

## ▓▒░ 1. Get the code

From GitHub (public):

```bash
git clone https://github.com/AlexC1991/VoxAI_Coder.git ~/voxai-build
cd ~/voxai-build && git pull        # later releases
```

or from CodeRook, when you are signed in with `cbx`:

```bash
cbx clone voxai-coder ~/voxai-build
cd ~/voxai-build && cbx get         # later releases
```

Check the version is the one Windows just released:

```bash
grep '"version"' ~/voxai-build/voxai-coder/package.json
```

## ▓▒░ 2. Prerequisites (once)

- **Node.js 20 or newer** and npm (Windows builds with Node 24).
- **Build tools for node-pty**, which `npm ci` compiles (there is no prebuilt Linux binary):

  ```bash
  sudo apt install -y build-essential python3          # Debian / Ubuntu
  sudo dnf install -y gcc-c++ make python3             # Fedora
  sudo pacman -S --needed base-devel python            # Arch
  ```

- **FUSE 2** to run AppImages: see [docs/LINUX.md](docs/LINUX.md#the-appimage-does-not-start).

Only for publishing a release (step 5):

- **cbx**, signed in: `npm install --global @coderook/cli`, then `cbx sign-in`, and check
  with `cbx whoami`.
- **The release signing key** at `~/.config/voxai-coder-release/update-key.pem`
  (`$VOX_RELEASE_KEY` overrides the path). It is the same private key Windows signs with,
  copied over by hand. **Never commit or upload it.** The release script refuses to run if
  it does not match the public key in `voxai-coder/resources/update-key.pem`.

## ▓▒░ 3. Install, test, build

```bash
cd ~/voxai-build/voxai-coder
npm ci
npm test
npm run dist:linux
```

`npm test` must exit 0. The tests know which platform they run on, and none of them calls
a model or spends credits.

`dist:linux` refreshes the page's CSP hash, empties `release/`, builds the AppImage, then
runs `scripts/linux-sh.js`. In `release/` you get:

- `VoxAI-Coder-<version>.AppImage`, the app;
- `VoxAI-Coder-<version>-Linux.sh`, the installer people download. It fetches that
  version's AppImage, checks it against the SHA-512 written into it, installs it under
  `~/.local` with a menu entry, and starts it.

To run from source without building, `npm start` (or `npm run dev` for dev tools) works on
Linux too. That copy does not update itself.

## ▓▒░ 4. Try it (a couple of minutes)

```bash
./release/VoxAI-Coder-*.AppImage
```

It should open. Worth a look on Linux:

- the **>_** terminal panel: your `$SHELL`, through the node-pty that `npm ci` compiled;
- **±** Review changes on a git folder;
- **@** in the message box lists the project's files;
- a command with `sudo` goes to the terminal panel, where you type the password.

Models on this PC and desktop computer use are Windows-only for now and say so. Close the
app before releasing.

## ▓▒░ 5. Add the Linux build to the release

Dry run first, then the real one:

```bash
npm run release -- --linux --dry-run
npm run release -- --linux
```

This signs the AppImage into `update-linux.json`, then attaches the AppImage, the `.sh` and
the manifest (in that order, so Linux copies never see a manifest before its file) to the
existing **v\<version\>** release on the `voxai-coder` project, and reads both update feeds back
the way an installed copy does. It has to end with both lines:

```
latest.yml offers <version>: signature, manifest and installer all check out.
latest-linux.yml offers <version>: signature, manifest and installer all check out.
```

It refuses, and changes nothing, if the Windows release for this version is missing, the
AppImage is missing or far too small, the `.sh` was made for a different AppImage, or the
key does not match.

## ▓▒░ 6. Afterwards

- Installed Linux copies update to this version by themselves.
- Do **not** bump the version on Linux, and do **not** run `npm run release` without
  `--linux` there: that would publish a release with no Windows installer.
- If you had to change code to make Linux work, commit it and push it
  (`git push`, and `cbx submit -m "…"`), so Windows has it before its next release.

---

## ▓▒░ Where the Linux code is

```
voxai-coder/
├── package.json              build.linux: AppImage target, icon, menu category
├── scripts/linux-sh.js       writes the installer script for the AppImage just built
├── scripts/release.js        --linux: signs update-linux.json, attaches to the release
├── src/main/updater.js       picks update-linux.json and the .AppImage on Linux; only an
│                             AppImage ($APPIMAGE set) updates itself
├── src/main/terminal.js      the terminal panel: $SHELL as a login shell
├── src/main/interactive.js   sudo and other prompts run on a pty in the terminal panel
├── src/main/main.js          keys through safeStorage (libsecret on Linux); local models
│                             switched off off Windows (LOCAL_SUPPORTED)
├── src/backend/agent.js      tells the model the platform and shell (PLATFORM_LINE)
├── src/backend/tools/
│   ├── index.js              the shell tool: /bin/sh -c on Linux
│   ├── sandbox.js            Auto mode: POSIX paths outside the project need asking
│   ├── terminal.js           sudo is refused in the shell tool, offered in the terminal
│   └── lsp.js, verify.js     python3 rather than python
└── src/backend/cu/
    ├── cdp.js                finds Chrome / Chromium / Edge / Brave in /usr/bin, /snap/bin
    └── native.js, uia.js,    Windows-only (desktop control); they report that on Linux
        win-input.js
```
