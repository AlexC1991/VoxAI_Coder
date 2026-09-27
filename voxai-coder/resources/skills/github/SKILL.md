---
name: github
description: Work with GitHub from the project -- sign in, create a repo, push, branches and pull requests, Actions CI, releases, issues -- with the gh command line. Load whenever a task mentions GitHub, a github.com URL, a PR, gh, or pushing/publishing code there.
---

# GitHub (gh)

## Before anything

- `gh --version`. Not installed: ask the user, then `winget install --id GitHub.cli -e`
  (a new shell picks it up). There is no npx version of gh.
- `gh auth status`. Not signed in: the USER runs `gh auth login` (it opens their
  browser). Never ask for a token in the chat, never print one, never write one into
  a file that is committed.
- `git remote -v` and `git status` first: know which repo and branch you are in.

## Ask before anything that leaves this computer

Creating a repo, pushing, opening or merging a PR, creating a release or an issue, and
changing settings are visible to others. Say what you will do (repo name, visibility,
branch) and get a yes -- ask_confirm -- unless the user has just asked for exactly that.
New repos are PRIVATE unless the user says public. Never change a repo's visibility,
delete a repo or branch, or force-push a shared branch unless the user asked for that,
by name.

## Common tasks

- New repo from this folder (after the first local commit):
  `gh repo create <name> --private --source . --remote origin --push`
- Clone: `gh repo clone <owner>/<repo>`
- Branch and PR:
  `git switch -c <branch>` ... commit ... `git push -u origin <branch>`
  `gh pr create --title "<title>" --body "<what and why>" --base main` (`--draft` if unfinished)
- PRs: `gh pr list`, `gh pr view <n>`, `gh pr checks <n>`, `gh pr diff <n>`,
  `gh pr merge <n> --squash` (only when asked).
- Actions: `gh run list --limit 5`, `gh run view <id> --log-failed` for why a run failed,
  `gh run watch <id>` to wait for one.
- Releases: `gh release create v1.2.0 --title "v1.2.0" --notes "<notes>" <files...>`
- Issues: `gh issue list`, `gh issue create --title "..." --body "..."`, `gh issue view <n>`
- Anything else: `gh api repos/<owner>/<repo>/...` (REST) -- read before you write.

## Before the first push

- A `.gitignore` for the stack (node_modules, build output, `.env*` except
  `.env.example`, `.voxai/`), and nothing secret staged: `git status` and
  `git diff --cached --stat` before committing.
- Commit messages say what changed and why, in a sentence.

## When it fails

- `HTTP 401/403`: not signed in or no access -- `gh auth status`; the user re-runs
  `gh auth login` (or `gh auth refresh -s <scope>` for a missing scope, e.g. `workflow`).
- `rejected (non-fast-forward)`: someone pushed first -- `git pull --rebase`, resolve,
  push. Do not force-push.
- Flags change between versions: `gh <command> --help` is the truth.
