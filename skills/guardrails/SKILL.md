---
name: guardrails
description: Baseline security, safety and quality rules for every change. Load it before writing code that touches auth, user input, databases, files, secrets, payments or external APIs; before adding a dependency; before running a risky shell command; and when reviewing or testing a branch.
metadata:
  tropa-managed: "true"
---

# Guardrails

These are industry-baseline rules (OWASP Top 10, the 12-factor app, common supply-chain advice). They apply to every agent. If a rule blocks the task, stop and ask @human in the room. Don't work around it.

## 1. Secrets
- Never put a secret in code, tests, docs, commits, logs or chat. That covers API keys, tokens, passwords, private keys and connection strings with passwords.
- Read secrets from environment variables. Keep real values in `.env` (git-ignored) and document every variable, with fake values, in `.env.example`.
- Never print or `cat` a secret, including when you're debugging. Check that one is set with `[ -n "$VAR" ]`.
- If a secret was committed or posted, tell @human at once: it must be **rotated**, not just deleted. Git history keeps it.
- Client-side code is public. Only publishable keys belong in the browser (e.g. a Supabase anon key, a Stripe publishable key). Service-role and secret keys stay on the server.

## 2. Security basics (web apps and APIs)
- **Validate all input on the server** with a schema (zod, pydantic, Joi …): type, length, format and allowed values. Client-side checks are for UX only.
- **No injection.** Use parameterised queries or an ORM, never string-built SQL. Never pass user input to a shell, `eval` or a template without escaping it. Use the framework's output escaping and avoid `dangerouslySetInnerHTML` / `v-html` with user data.
- **Authentication:** use the framework's or provider's auth; don't write your own crypto. Hash passwords with bcrypt, scrypt or argon2. Cookies are `HttpOnly`, `Secure` and `SameSite`.
- **Authorisation on every request:** check that *this* user may read or change *this* record on the server. Hiding a button is not access control (OWASP #1: broken access control). Supabase tables need row-level security turned on.
- **CORS:** allow only the origins you need. Never use `*` together with credentials.
- **Rate-limit** login, sign-up, password reset and any endpoint that costs money (AI calls, email, SMS).
- **File uploads:** limit size and type, generate the stored file name yourself, never serve uploads as HTML from your main domain, and never use user input in a file path (path traversal).
- **Errors:** users see a generic message; details go to server logs. No stack traces in responses. Never log passwords, tokens or full card numbers.
- **HTTPS** in every deployed environment. Set security headers (CSP, `X-Content-Type-Options`, `frame-ancestors`) with the framework's helper (e.g. helmet).
- **Don't disable safety checks** to "make it work": no `verify=False` / `rejectUnauthorized: false`, no turning off CSRF protection, no `chmod 777`.

## 3. Agent safety (shell and git)
Ask @human in the room and wait for an OK before you:
- delete anything outside your own task's files, or run `rm -rf` on anything but build output (`node_modules`, `dist`, `.next`, caches)
- run `git push`, `git push --force`, `git reset --hard`, `git clean -fd`, rewrite history, or delete a branch that isn't yours
- run `git commit --no-verify`. The pre-commit check is there to stop leaked secrets.
- drop or truncate a table, run a migration on any shared or production database, or bulk-delete data
- change production settings, env vars, DNS or billing, or deploy to production
- pipe a download into a shell (`curl … | sh`), or install global packages or system software
- expose a local port to the internet. Use the tropa `request_share` tool, never ngrok, cloudflared or localtunnel directly.
- work outside the project folder

## 4. Dependencies
- Prefer the standard library and packages the project already has. Add a package only when it saves real work.
- Before adding one, check that it's the **real, maintained package**: the exact name (typosquats look alike), recent releases, real usage, and a licence compatible with the project (MIT, Apache-2.0, BSD and ISC are fine; ask before GPL/AGPL or "no licence").
- Commit the lockfile (`package-lock.json`, `pnpm-lock.yaml`, `uv.lock`, `poetry.lock` …). Install with `npm ci` / `pnpm install --frozen-lockfile` when the lockfile exists.
- After adding dependencies, run the audit (`npm audit --omit=dev`, `pnpm audit`, `pip-audit`) and fix or report **high** and **critical** findings.
- Never copy code from a random gist or paste in minified code you can't read.

## 5. Quality
- New behaviour comes with tests. Fixed bugs get a test that failed before the fix.
- Run the linter, the type checker and the tests before you hand off. Say in the handoff which commands you ran.
- Keep changes small and on-task. No commented-out code, debug prints or TODOs without an owner.

## Before handing off (developers), approving (lead) or passing (QA)
- [ ] No secrets in the diff (`git diff <base>...<branch>`); `.env` not committed; new variables are in `.env.example`
- [ ] Server-side input validation and authorisation checks on new endpoints
- [ ] No string-built SQL or shell commands with user input
- [ ] New dependencies checked (real package, licence, audit clean of high/critical)
- [ ] Lint, type check and tests pass
State it in one line, e.g. `guardrails: ✅ secrets · ✅ input/auth · ✅ deps (npm audit clean) · ✅ tests 42/42`.
