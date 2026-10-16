# gungz

An iMessage assistant you text to do multi-step web work — e.g. *"find AI
hackathons in SF next month under $50 and register me"* — powered by
[Photon Spectrum](https://photon.codes/docs/spectrum-ts) (iMessage loop) and
[TinyFish](https://docs.tinyfish.ai) (Search, Fetch, Agent web tools) behind a
Gemini Flash brain with quota-proof fallbacks.

How it works: staged, user-gated pipeline — **search → pick → fetch →
reg-check → collect → confirm (SUBMIT) → submit**. Each TinyFish tool fires
only on your explicit confirmation. See [`PLAN.md`](./PLAN.md) (architecture),
[`DEMO.md`](./DEMO.md) (60s video script + walkthrough),
[`SUBMISSION.md`](./SUBMISSION.md) (hackathon submission).

## Prerequisites

- Node.js 20+ and **yarn** (this repo pins `yarn@1.22` via `packageManager`;
  `pnpm` will refuse to install).
- API keys (all free tiers):
  - Photon: `PROJECT_ID` / `PROJECT_SECRET` from your project Settings on the
    [Photon dashboard](https://app.photon.codes).
  - TinyFish: `TINYFISH_API_KEY` from
    [agent.tinyfish.ai/api-keys](https://agent.tinyfish.ai/api-keys)
    (Search 12k req/day free, Fetch 1k URLs/day free, Agent on $8 new-account credit).
  - Gemini: `GEMINI_API_KEY` from
    [AI Studio](https://aistudio.google.com/app/apikey) (free tier).

## Setup

```sh
yarn install
cp .env.example .env
# then edit .env and fill in the values (never commit .env — it is gitignored)
```

| Variable | Required | What |
|---|---|---|
| `PROJECT_ID` / `PROJECT_SECRET` | yes | Photon Spectrum Cloud project |
| `TINYFISH_API_KEY` | yes | TinyFish Search / Fetch / Agent |
| `GEMINI_API_KEY` | yes | Gemini Flash brain |
| `GEMINI_MODEL` | no | Default `gemini-2.0-flash`. Use a Flash model — Gemma models don't serve tool calls reliably |
| `GEMINI_FALLBACK_MODEL` | no | Default `gemini-2.5-flash-lite`. Tried when the primary model's quota is hit |
| `LLM_TIMEOUT_MS` | no | Per-LLM-call timeout, default `60000` |
| `AGENT_TIMEOUT_MS` / `AGENT_MAX_STEPS` / `AGENT_MAX_DURATION_SECONDS` | no | Agent bounds, defaults `90000` / `12` / `75` |
| `ENABLE_TERMINAL` | no | Set to `1` only if the terminal TUI works for you (needs 127.0.0.1 loopback + TTY); otherwise use `yarn chat` |
| `SIMULATE_QUOTA_EXHAUSTION` | no | Set to `1` for dev-only quota-fallback rehearsal (synthetic error, zero real quota) |

## Run

| Command | What |
|---|---|
| `yarn start` | Production loop: iMessage provider. Text the Photon line from your phone |
| `yarn dev` | Same, with auto-reload on file changes |
| `yarn chat` | Local stdin/stdout REPL driving the **identical** turn logic (`handleTurn`) — no iMessage, no TUI. Use for dev and rehearsal |

Boot check (verifies keys + providers, leaves nothing running):

```sh
yarn start > /tmp/gungz-boot.log 2>&1 & APP=$!; sleep 15; kill $APP
head -12 /tmp/gungz-boot.log
```

Expect `active: imessage only`, all four keys `set`. The `kill` stops the app;
`head` only reads the log — nothing lingers. Confirm with:

```sh
ps aux | grep -E "tsx|dev-chat" | grep -v grep   # empty = clean
```

Stopping: `Ctrl+C` for foreground runs; `kill <pid>` (or `pkill -f
"tsx --env-file=.env src/<file>.ts"`) for backgrounded ones.

## Try it (`yarn chat`)

```text
you:    Find AI hackathons to join
agent:  Which city, and what dates?
you:    SF next month, under $50
agent:  1. … 2. … 3. … Which one do you want to know more about?
you:    2
agent:  [details + fee/deadline] Want me to check the registration?
you:    yes
agent:  [fields to prepare + manual link] Want me to fill it in for you?
you:    yes
agent:  Reply with the values: name, email, team size?
you:    Ada, ada@example.com, solo
agent:  Echo back — … Reply SUBMIT to confirm.
you:    SUBMIT
agent:  [fills + submits] Registered (or manual-link fallback).
```

Rules the agent follows: upcoming events only (past ones only on explicit ask);
one stage per turn; registration values live only in the in-memory session
(30-min TTL); login/OAuth walls always degrade to manual link + checklist —
passwords are never requested; submit happens only on your exact `SUBMIT`.

## Test from iMessage (your iPhone)

`yarn chat` proves the brain; this proves the real transport end to end.

1. **Find your line.** The number you text from your iPhone:
   ```sh
   photon spectrum lines list
   ```
   (Needs the `photon-cli` skill: `npx skills add photon-hq/skills --skill photon-cli`.
   Confirm auth first with `photon whoami`, `photon login` if needed.)
2. **Register your phone (shared-pool plans only).** On Free/Pro plans the app
   sends from a shared pool, and you must add your iPhone number as a project
   user in the [Photon dashboard](https://app.photon.codes) first — otherwise
   the first send fails with `Target not allowed for this project`. Business
   (dedicated-line) projects skip this: every user texts the same number.
3. **Start the app** in a terminal you keep open:
   ```sh
   yarn start
   ```
   Expect the `[env]` lines all `set` and `[providers] active: imessage only`.
4. **Text the line** from your iPhone, following the staged script:
   `Find AI hackathons to join` → answer city/dates → pick a number → `yes`
   to reg-check → `yes` to fill → dictate values → review the echo → `SUBMIT`.
5. **What you should see:** instant 👍 tapback on each text, a typing
   indicator while tools run (Search ~seconds, Agent up to ~90s), then threaded
   replies with the summary plus tappable `richlink` unfurls per source.

Limits to know: 5,000 messages/server/day, 50 *new* conversations per line per
day (replies in an existing thread don't count). For a fresh-number test, use a
second phone or ask a friend — but register them first on shared-pool plans.

If a reply never arrives: check the app terminal for `[turn]` / `[tool:]`
lines (they name the failing stage), then see Troubleshooting below.

## Safety notes

- The Agent step reads pages and (only after double consent) fills/submits
  forms. Rehearse through CONFIRM, and only `SUBMIT` on a test form or your
  real demo target.
- Rotating keys (`TINYFISH_API_KEY`, `GEMINI_API_KEY`) is the way to fully
  retire a deployed demo.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `tuichat: subprocess did not connect` | Don't set `ENABLE_TERMINAL`; use `yarn chat` |
| `[env] X: MISSING` at boot | Add it to `.env` (names in `.env.example`), restart |
| Gemini `400 thought_signature` | Fixed in `src/llm.ts` (`modelTurnParts` echoes raw parts); pull latest |
| Gemini `429` / `503` / hangs | Auto-retried with backoff + model rotation, then deterministic fallback — just resend |
| `Unrecognized key: "session_id"` | Old `src/tools.ts`; pull latest (key no longer sent over SDK) |
| Past events showing up | Date gate (`src/dates.ts`) drops past-only pages; `unknown`-date pages are kept, never excluded |

## Where to go next

- [Spectrum docs](https://photon.codes/docs/spectrum-ts) · [TinyFish docs](https://docs.tinyfish.ai)
- `src/` map: `index.ts` (Spectrum loop) · `dev-chat.ts` (REPL) · `turn.ts`
  (shared turn) · `llm.ts` (brain + fallbacks) · `tools.ts` (TinyFish tools) ·
  `deterministic.ts` (zero-LLM chain) · `session.ts` · `format.ts` · `dates.ts`
