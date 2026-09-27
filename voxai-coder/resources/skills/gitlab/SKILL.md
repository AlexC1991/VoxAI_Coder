---
name: gitlab
description: Work with GitLab (gitlab.com or a company's own GitLab) -- sign in, create a project, push, merge requests, CI pipelines, releases, issues -- with the glab command line. Load whenever a task mentions GitLab, a gitlab URL, an MR, glab or .gitlab-ci.yml.
---

# GitLab (glab)

## Before anything

- `glab --version`. Not installed: `winget install --id GLab.GLab -e` (then a new shell).
- `glab auth status`. Not signed in: the USER runs `glab auth login` (it can open the
  browser; for a company server add `--hostname gitlab.example.com`). Never ask for a
  token in the chat or print one. A token can also come from the `GITLAB_TOKEN`
  environment variable -- set by the user, never written into the project.
- `git remote -v` and `git status` first. Merge requests, not pull requests, on GitLab.

## Ask before anything that leaves this computer

Creating a project, pushing, opening or merging an MR, releases and issues are visible
to others: say what you will do and get a yes (ask_confirm) unless the user just asked
for exactly that. New projects are PRIVATE unless the user says otherwise. Never change
visibility, delete a project or branch, or force-push a shared branch unless asked, by name.

## Common tasks

- New project from this folder (after the first local commit):
  `glab repo create <name> --private` then `git remote add origin <url it printed>` and
  `git push -u origin main` (check the default branch name with `git branch --show-current`).
- Clone: `glab repo clone <group>/<project>`
- Branch and MR:
  `git switch -c <branch>` ... commit ... `git push -u origin <branch>`
  `glab mr create --fill --target-branch main` (`--draft` if unfinished; `--title` and
  `--description` to write your own instead of `--fill`)
- MRs: `glab mr list`, `glab mr view <n>`, `glab mr diff <n>`, `glab mr merge <n>` (only when asked).
- CI: `glab ci status` (this branch's pipeline), `glab ci view` (interactive -- avoid in
  a non-interactive shell), `glab ci list`, `glab ci trace <job-id>` for a job's log.
  Pipelines are defined in `.gitlab-ci.yml`; `glab ci lint` checks it.
- Releases: `glab release create v1.2.0 --notes "<notes>" <files...>`
- Issues: `glab issue list`, `glab issue create --title "..." --description "..."`
- Anything else: `glab api projects/:id/...` (REST).

## Before the first push

- A `.gitignore` (dependencies, build output, `.env*` except `.env.example`, `.voxai/`),
  nothing secret staged: `git status`, `git diff --cached --stat`.

## When it fails

- 401/403: `glab auth status`; the user signs in again. On a company GitLab, the right
  `--hostname` matters.
- Rejected push: `git pull --rebase`, resolve, push. No force-push.
- Flags change: `glab <command> --help` is the truth.
