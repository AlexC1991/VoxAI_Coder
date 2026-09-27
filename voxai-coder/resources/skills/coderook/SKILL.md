---
name: coderook
description: Save and fetch projects on CodeRook with the cbx command line -- whole-folder versions (no staging, no branches to rebase), lines of work, merges, releases and downloads. Load whenever a task mentions CodeRook, cbx, "save to CodeRook", a coderook.com URL or a .cbx bundle.
---

# CodeRook (cbx)

CodeRook stores whole snapshots of a folder: a version names every file the project
had at that moment. There is no staging area and no history to rewrite.

## Before anything

- `cbx whoami`. Not found: `npm install --global @coderook/cli` (or put
  `npx -y @coderook/cli` where `cbx` appears). Refused: the USER runs `cbx sign-in`
  (it takes a personal access token -- never ask for it in the chat, never run it for them).
- `cbx status` says what changed since the folder's last version, and which project it
  is linked to. It changes nothing: use it freely.

## Saving (ask first)

- `cbx submit -n` shows exactly what would be sent. Safe; use it to answer "what would
  this upload?".
- `cbx submit -m "<what changed, in a sentence>"` saves a version. It leaves a mark on the
  user's account: propose it, say what it will send, and get a yes -- unless the user
  just asked to save. Write the message from the actual diff; never "update".
- The message is at most 240 characters.
- A folder not yet linked becomes a NEW private project named after the folder
  (`--name <project>` to choose). Do not guess an existing project's name: `cbx projects`
  lists them.
- Files the project's own `.gitignore` excludes are refused if an earlier version had
  them: `--sync` leaves them out of the new version (older versions keep them).
- A file that looks like a credential is refused; `--allow-secrets` only after checking
  it really is not one (a PUBLIC key is fine; a private key never).

## Reading and fetching

- `cbx projects`, `cbx versions [project]`, `cbx tracks [project]`.
- `cbx get` brings the folder up to date and protects local edits; `cbx get --replace`
  discards them -- only when the user says so in those words.
- `cbx clone <project> [dir]` fetches a project into a new folder.

## Lines of work and collisions

- `cbx track` (which line), `cbx track <name> --new` (start one), `cbx submit --track <name> -m "..."`.
- A save made while behind becomes a merge waiting on a decision: `cbx merges`,
  `cbx merge <ref>`. Read the conflict to the user and let THEM choose -- never pick a side.

## Releases and downloads

- `cbx release v1.2.0 --notes "..."` names the latest save as a release;
  `cbx attach <file>` adds a download to it (attach first, name last, so a release is
  never public without its files). `cbx mark <n> --name v1.0` names an older save.
- A public project's page has no releases list: link downloads from its README.

## Never

- `cbx delete` unless the user asked for that project to be deleted, by name.
- `cbx sign-out` -- it costs them a token to fetch again.
- Another route in when a command refuses (a project that blocks machines was set that
  way on purpose): pass the message on as it is.
