---
name: service-setup
description: Set up an outside service for a project -- hosting and deploys, a database, auth, payments, email, DNS, storage -- in a safe order, with the user doing the account steps and secrets kept out of the chat. Load when a task needs an account, an API key, a dashboard setting or a deployment.
---

# Setting up a service

## 1. Plan before touching anything

- Say what the service needs: accounts, resources to create, settings, environment
  variables, a domain, what it will cost if anything.
- Ask the user the decisions that are theirs with one ask_user call: which provider,
  which plan or region, which domain, staging first or straight to production.
- If a skill exists for the service (see the skills index -- `wrangler` and
  `cloudflare` for Cloudflare, for example), load it. Otherwise check the service's
  current docs with web_search / web_fetch: commands and flags change.

## 2. Who does what

The user does:
- creating accounts, signing in, accepting terms, entering payment details, choosing a
  paid plan -- anything that commits them or costs money;
- creating API keys and tokens. Tell them the exact page and the smallest permissions to
  pick (one project or zone, only the actions needed, an expiry if offered).

You do:
- installing and running the service's command-line tool (`npx <tool>` avoids a global
  install), writing config and code, deploying, and checking the result;
- the browser only for what has no command or API (load `preview-browser`).

## 3. Secrets never go through the chat

- Never ask the user to paste a secret into the chat, and never print one: the chat is
  sent to the model provider and saved with the session.
- Best: the tool's own login, which opens the user's normal browser and keeps the
  credential itself -- `npx wrangler login`, `npx vercel login`, `gh auth login`,
  `stripe login`, `supabase login`.
- Otherwise: create the env file with the variable NAMES and empty values (`.env`,
  `.env.local`, or `.dev.vars` for Cloudflare Workers), make sure it is in `.gitignore`,
  and ask the user to fill it in and save. Commit a `.env.example` with names only.
- Do not read the filled-in file back or echo its values. Code and scripts read
  `process.env.NAME`.
- Commands here run in cmd.exe on Windows, where JSON in a `curl` command is fragile.
  For an API call, write a small Node script that reads the token from the environment
  (`node --env-file=.env script.mjs`) and prints only the result.

## 4. Change things carefully

- Least privilege, and staging or preview before production where the service has it.
- Before anything destructive, public or billed -- deleting a resource, changing DNS on
  a live domain, a production deploy, making data public, anything that starts a charge --
  say exactly what will happen and get a yes with ask_confirm.
- One change at a time, and check it before the next.

## 5. Finish properly

- Verify: open the deployed URL (web_fetch, or the preview), run the health check, show
  the output.
- Write down what now exists, in the project's README or with the memory tool: resource
  names and IDs, the environment variables needed (names only), how to redeploy, and
  anything the user still has to do.
