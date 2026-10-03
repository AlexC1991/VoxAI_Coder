# Linux build — instructions for the Linux side of this machine

Windows and Linux are on the same PC. Windows released **VoxAI Coder 0.2.82** on
2026-10-04 (CodeRook `voxai-coder` **v102**, git commit `b642ad1`). That release has
the Windows installer only. Linux's job is to add the AppImage, the Linux installer
script and the signed Linux manifest **to the same 0.2.82 release**.

Do this for every Windows release: the version to build is whatever
`voxai-coder/package.json` says.

---

## 0. Do NOT build in this folder

This folder (`A:\Github\VoxAI_Coder` on Windows) is the Windows working copy. Do not run
`npm ci` / `npm install` / `npm run dist:linux` in it from Linux:

- it would replace `node_modules` (Electron, node-pty) with Linux builds and break the
  Windows copy;
- NTFS is a poor place to build an AppImage (permissions, symlinks).

Build from a separate copy in your Linux home folder instead (step 1).

## 1. Get the code (a separate copy)

First time:

```bash
cbx clone voxai-coder ~/voxai-build
```

Already have `~/voxai-build` from an earlier release:

```bash
cd ~/voxai-build && cbx get
```

Check it is the right version (should print 0.2.82 for this release):

```bash
grep '"version"' ~/voxai-build/voxai-coder/package.json
```

## 2. Prerequisites (once)

- Node.js 22 or newer (Windows used 24.14) and npm.
- Build tools for node-pty (it has no prebuilt Linux binary; `npm ci` compiles it):

  ```bash
  sudo apt install -y build-essential python3
  ```

- FUSE 2 to run AppImages: `sudo apt install -y libfuse2` (Ubuntu 24.04+: `libfuse2t64`).
- `cbx` signed in (`cbx whoami`).
- The release signing key at `~/.config/voxai-coder-release/update-key.pem` — the same key
  the Windows side uses (it already signed 0.2.80's Linux manifest from here). **Never commit
  or upload this file.** The release script refuses if it does not match the public key in
  `voxai-coder/resources/update-key.pem`.

## 3. Install, test, build

```bash
cd ~/voxai-build/voxai-coder
npm ci
npm test
npm run dist:linux
```

`npm test` must exit 0 (the tests are platform-aware). `dist:linux` makes, in `release/`:

- `VoxAI-Coder-0.2.82.AppImage`
- `VoxAI-Coder-0.2.82-Linux.sh` — the installer people download: it fetches that version's
  AppImage, checks its SHA-512, installs it under `~/.local` with a menu entry, and starts it.

## 4. Quick check (optional, ~2 minutes)

```bash
./release/VoxAI-Coder-0.2.82.AppImage
```

It should open. New in 0.2.82 and worth a look on Linux:

- the **>_** terminal panel (uses your `$SHELL`; this is the node-pty that `npm ci` compiled);
- the **±** Review changes screen on a git folder;
- typing **@** in the message box lists the project's files.

"Models on this PC" are Windows-only for now and say so in Settings.

Close it before releasing.

## 5. Add the Linux files to the 0.2.82 release

Dry run first, then the real one:

```bash
npm run release -- --linux --dry-run
npm run release -- --linux
```

This attaches `VoxAI-Coder-0.2.82.AppImage`, `VoxAI-Coder-0.2.82-Linux.sh` and the signed
`update-linux.json` to the existing **v0.2.82** release on `voxai-coder-releases`, then reads
both update feeds back. It must end with both lines:

```
latest.yml offers 0.2.82: signature, manifest and installer all check out.
latest-linux.yml offers 0.2.82: signature, manifest and installer all check out.
```

It refuses (and changes nothing) if the Windows release is missing, the build did not
finish, the `.sh` was made for a different AppImage, or the key does not match.

## 6. Afterwards

- Installed Linux copies on 0.2.80 will now update to 0.2.82 by themselves.
- Do **not** bump the version, and do **not** run `npm run release` without `--linux`
  (that would publish a new Windows-less release).
- If you had to change code to make Linux work, commit it in `~/voxai-build`, save it with
  `cbx submit -m "…"`, and leave a note here so the Windows side picks it up (`cbx get`)
  before its next release.
- Nothing from `~/voxai-build` needs copying back into this folder.
