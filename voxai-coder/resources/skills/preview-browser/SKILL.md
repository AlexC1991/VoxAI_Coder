---
name: preview-browser
description: Use the app's preview browser for a website, a dashboard or a sign-in -- open pages, have the user sign in, read and act on pages with their approval, and capture a window. Load before any task that needs a web page the code cannot reach.
---

# The preview browser

The preview is a real browser (Chromium) in the panel beside the chat. The user sees
exactly what you see and can use it themselves: they can type an address, click, and
sign in. You drive it with the `computer` tool.

## First: is the browser the right tool?

Prefer a command-line tool or an API whenever the service has one (`wrangler`,
`vercel`, `gh`, `stripe`, a REST API with a token). It is faster, it does exactly what
it says, its output shows in the thread, and it does not break when a page is
redesigned. Use the browser for what only a website does -- a setting with no API, a
page to check, a sign-in -- or to look at the result.

If a skill exists for the service (check the skills index), load it too.

## Actions

- `open` with a `url` (or a project file path) -- shows it in the preview and returns
  the page text and a numbered list of the things you can click or type into.
- `state` -- the page as it is now: text, numbered elements, and a screenshot if your
  model can see images. Read it before acting and again after, every time.
- `click` with `index` (a number from the element list; prefer it to x/y).
- `type` with `text` -- types into whatever has focus, so click the field first.
- `press` with `key` (`Enter`, `Tab`, `Escape`, `Control+A`...).
- `scroll` with `dy` (positive is down).
- `screenshot` -- the page. With `backend: "native"`: the Windows desktop, or one window
  with `window` (part of its title or the app name), captured even when covered. To work
  inside a desktop app rather than a web page, load the `computer-use` skill.

## Signing in: the user does it

- Never type a password, a 2FA code, a recovery code or an API key yourself, and never
  ask the user to paste one into the chat: the chat is sent to the model provider and
  saved. You cannot read what is in a password field anyway.
- Open the sign-in page, then ask the user (ask_user or ask_confirm) to sign in in the
  preview and tell you when they are done. Human checks ("I am not a robot", Turnstile)
  are theirs too.
- "Sign in with Google" works in the preview: the user types their Google details and may
  be asked to confirm on their phone. "Sign in with GitHub / Microsoft / Apple" and company
  single sign-on work the same way; a sign-in pop-up opens over the app and closes itself.
- If a sign-in page refuses the preview ("this browser may not be secure"), offer an
  email-and-password sign-in if the site has one, or the command-line route, whose login
  (`npx wrangler login`, `vercel login`, `gh auth login`) opens the user's normal browser.
- A sign-in stays with the preview; if a page shows the user is signed out, ask them to
  sign in again rather than guessing.

## Acting on a signed-in site

- Every click, typing or key press on a real website (not localhost, not a project
  file) asks the user first; they see "Act on this website?" with the element and the
  site, and may choose "Always on <site>" for the session. That prompt shows only the
  button's label, not what it does -- so before anything that deletes, pays, publishes,
  changes DNS, billing, security or team members, or cannot be undone, say what will
  happen and get a clear yes with ask_confirm first.
- Stay on task: visit only the pages the task needs. Everything you read is sent to the
  model provider.
- One action at a time, then `state`, then say what changed. If something unexpected
  appears (a warning, a confirmation dialog, a price), stop and tell the user.

## Local pages

A dev server on localhost or a page in the project needs no sign-in and no website
approval: `open` it, check it, fix the code, reload with `open` again.

## When it does not work

- "Nothing is open in the preview" -- `open` a page first.
- A blank or half-drawn page -- wait a moment and `state` again; a single-page app may
  still be loading.
- The window is minimised -- screenshots cannot see it; ask the user to restore it.
- The element list is missing what you need -- `scroll` and `state` again, or use x/y
  from a screenshot as a last resort.
