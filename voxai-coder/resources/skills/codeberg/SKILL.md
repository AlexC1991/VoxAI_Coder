---
name: codeberg
description: Work with Codeberg (codeberg.org, a Forgejo host for free and open-source projects) -- create a repo, push, pull requests, releases, issues, Pages -- with git, Codeberg's API and optionally the fj command line. Load whenever a task mentions Codeberg, codeberg.org, Forgejo or fj.
---

# Codeberg

Codeberg runs Forgejo. Git itself does the pushing; creating repos and pull requests
goes through the web site, its REST API (`https://codeberg.org/api/v1`), or the `fj`
command line (forgejo-cli). Codeberg is for free/open-source work: private repos are
allowed only in small amounts -- say so if the user wants a private project there.

## Before anything

- `git remote -v` and `git status`: know where you are.
- Signing in is the USER's: for git over HTTPS, Git Credential Manager asks them the
  first time they push (username + an access token made at
  codeberg.org > Settings > Applications). Or an SSH key they add under Settings > SSH keys.
- For the API the user sets `CODEBERG_TOKEN` in their own environment -- never in the
  chat, never in a committed file.
- `fj` (optional): `fj --version`; if present, `fj auth login` is run by the user.
  Its flags differ between versions: check `fj --help` and `fj <command> --help` first.

## Ask before anything that leaves this computer

Creating a repo, pushing, pull requests, releases and issues are public by default on
Codeberg. Say what you will do and get a yes (ask_confirm) unless the user just asked
for exactly that. Never delete a repo or branch, or force-push a shared branch, unless asked.

## Common tasks

- New repo (the user may prefer to click "New repository" on the site; with the API):
  `curl -s -X POST https://codeberg.org/api/v1/user/repos -H "Authorization: token %CODEBERG_TOKEN%" -H "Content-Type: application/json" -d "{\"name\":\"<name>\",\"private\":false}"`
  then `git remote add origin https://codeberg.org/<user>/<name>.git` and `git push -u origin main`.
- Pull request from a branch in the same repo:
  `git push -u origin <branch>`, then
  `curl -s -X POST https://codeberg.org/api/v1/repos/<owner>/<repo>/pulls -H "Authorization: token %CODEBERG_TOKEN%" -H "Content-Type: application/json" -d "{\"title\":\"...\",\"head\":\"<branch>\",\"base\":\"main\",\"body\":\"...\"}"`
  (or `fj pr create` -- see its --help; it can make AGit pull requests without a fork).
- Contributing to someone else's repo: fork on the site, push to your fork, open the PR.
- Releases: POST `/repos/<owner>/<repo>/releases` with `{"tag_name":"v1.0.0","name":"v1.0.0","body":"..."}`;
  issues: POST `/repos/<owner>/<repo>/issues` with `{"title":"...","body":"..."}`.
- CI: Forgejo Actions (`.forgejo/workflows/*.yml`, GitHub-Actions-like syntax) where
  enabled for the repo; Woodpecker (`.woodpecker.yml`) via ci.codeberg.org also exists.
- Static site: Codeberg Pages -- see docs.codeberg.org/codeberg-pages before setting it up.

## Before the first push

- A `.gitignore` (dependencies, build output, `.env*` except `.env.example`, `.voxai/`),
  nothing secret staged: `git status`, `git diff --cached --stat`.

## When it fails

- 401: the token is missing or lacks a scope (repository write). The user makes a new one.
- Rejected push: `git pull --rebase`, resolve, push. No force-push.
- API shape in doubt: `https://codeberg.org/api/swagger` documents every call.
