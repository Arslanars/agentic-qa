# Onboarding — Agentic QA Pipeline

Welcome. This framework turns a user story into runnable Playwright tests, runs them in a visible browser, and produces an AI-written report — all from a single web UI.

You'll be productive in **under 5 minutes**.

---

## What you need

| Tool | Minimum version | Check |
|------|-----------------|-------|
| **Node.js** | 18+ | `node --version` |
| **Git** | any | `git --version` |
| (Optional) **Java JDK** | 8+ | `java -version` — needed only if you want Allure HTML locally; CI/cloud doesn't need it |
| (Optional) **Anthropic API key** | — | for the "✨ Generate & Run" button only; running existing tests doesn't need it |

If `node` says 16 or older, install LTS from <https://nodejs.org>.

---

## Setup (one command)

```bash
git clone <repo-url> agentic-qa
cd agentic-qa
npm run setup
```

`npm run setup` does:

1. `npm install` — installs Playwright, Express, Anthropic SDK, Allure CLI
2. `npx playwright install` — downloads the Chromium/Firefox/WebKit binaries (~300 MB, one-time)
3. Copies `.env.example` → `.env` (creates an env file you can fill in later)
4. Prints a green checklist and tells you what to run next

Linux/macOS users may also need: `npx playwright install-deps` (system libs for Chromium). The script will tell you if that's needed.

---

## First run (60 seconds)

```bash
npm run ui
```

Open <http://localhost:3001>. The dropdown is empty on a fresh install — you haven't generated any features yet.

### Try the full pipeline on your own app

1. In the form on the left, paste:
   - **Application URL**: a page in your app (e.g. a login screen)
   - **Story title**: e.g. "User login"
   - **Acceptance Criteria**: one AC per line
2. Click **✨ Generate &amp; Run** (requires `ANTHROPIC_API_KEY` in `.env`)
3. The framework explores the URL, generates POMs + specs, then runs them

Or if you already have a Playwright suite in `tests/<feature>/*.spec.ts`, it appears in the dropdown automatically. Pick it, click **▶ Run Tests**, and watch the visible browser run.

You should see:

- A Chromium window pops up and runs each test in sequence
- The right panel streams `N passed (X.Xs)`
- The status badge flips green
- The screenshots gallery fills with thumbnails — click any to see the page state captured at the end of that test
- The footer shows links to the Allure, Playwright HTML, and AI markdown reports

That's the whole framework, end-to-end. **No Claude Code needed for any of that.**

---

## What's where

```
.
├── ui/                       ← Web UI (Express + vanilla HTML/JS)
│   ├── server.js             ← API endpoints (run / generate / screenshots / reports)
│   ├── generator.js          ← AI generator using Claude API
│   └── index.html            ← Single-page frontend
├── user-stories/             ← INPUT: drop new stories here as .md files
│   └── _TEMPLATE.md          ← Copy this for new stories
├── pages/                    ← Page Object Model classes (one per page)
│   ├── BasePage.ts
│   └── <feature>/<PageName>Page.ts
├── tests/                    ← Generated Playwright specs (one per AC)
│   └── <feature>/*.spec.ts
├── specs/                    ← AI-generated test plans (markdown)
├── reports/                  ← AI-written execution reports (markdown, committed)
├── test-results/             ← Playwright per-run artifacts (gitignored)
├── allure-results/           ← Raw Allure JSON (gitignored)
├── allure-report/            ← Allure HTML dashboard (gitignored, regenerated each run)
├── playwright.config.js
└── QAEnd2EndPromptFile.md    ← Reusable prompts for Claude Code path
```

---

## Adding a new feature to test — three paths

### Path A: Use the UI's Generate button (easiest)

1. In the UI, fill in: **URL**, **Story Title**, **Acceptance Criteria** (one AC per line)
2. Click **✨ Generate & Run**
3. The framework: explores the URL, builds POMs, generates specs, runs them, saves a report
4. **Requires:** `ANTHROPIC_API_KEY` set in your `.env`. Without it the button cleanly says so.

### Path B: Use Claude Code (no API key required)

1. Open this folder in Claude Code (VS Code extension)
2. Open [QAEnd2EndPromptFile.md](QAEnd2EndPromptFile.md), copy the **Express Prompt** block at the top
3. Paste into Claude Code with your URL + story + ACs filled in
4. Claude generates everything; the new feature shows up in the UI dropdown on reload
5. Click ▶ Run Tests

### Path C: Hand-author (full control)

1. Copy `user-stories/_TEMPLATE.md` to `user-stories/<STORY-ID>-<slug>.md`
2. Write a POM in `pages/<slug>/<PageName>Page.ts` extending `BasePage`
3. Write specs in `tests/<slug>/*.spec.ts` that import the POM
4. Run via UI or `npm run test:chromium`

POM convention details: [pages/README.md](pages/README.md).

---

## Self-healing pattern

When the UI changes and a locator stops matching, the framework's `playwright-test-healer` agent inspects the live page, finds the correct selector, and patches one line in the POM. Specs are untouched — the heal lives where the locator lives.

To demonstrate it on your own suite:

1. Open any generated POM in `pages/<feature>/<PageName>Page.ts`
2. Change a locator's accessible name to something wrong (e.g. `'Sign In'` → `'Login'`)
3. Run tests — they fail with a precise error pointing at the wrong locator
4. Open the failing test's screenshot in the gallery — shows the page as it actually is
5. Inspect the live app for the real name (via Claude Code's MCP, or just open the page)
6. Fix the one line in the POM
7. Re-run — green again

A single edit can heal every spec that depends on that locator. That's the POM payoff.

---

## Environment variables

`.env.example` lists every variable. Copy to `.env` and fill in only what you need:

| Variable | Used for | Required? |
|----------|----------|-----------|
| `ANTHROPIC_API_KEY` | UI ✨ Generate button | No — only if you use the in-UI generator |
| `<APP>_*` (your own credentials) | Generated tests that need real auth — referenced via `process.env.<NAME>` with placeholder fallbacks | No — the generator inserts these as needed when you supply credentials in the story form |
| `UI_PORT` | Change UI server port from default `3001` | No |

---

## Common gotchas

- **"0 passed" or empty log on Run Tests** — hard-reload (Ctrl+F5). Cached old JS.
- **Headed mode doesn't show a browser** — make sure ☑ Headed is checked; on Linux you may need a display server (X / Xvfb) or use headless.
- **Allure link gives a 404 / report shows stale tests** — install Java (`winget install Microsoft.OpenJDK.21` on Windows). The Allure CLI is a Java tool.
- **API generation says "ANTHROPIC_API_KEY is not set"** — get a key at <https://console.anthropic.com> and put it in `.env`, then restart `npm run ui`. New accounts get $5 free credit; expect ~$0.20 per generation on Sonnet, ~$0.30 on Opus.
- **Tests blink past in headed mode** — that's because 8 workers run in parallel. The UI already forces `--workers=1` for headed runs so you can watch each one.

---

## CI

`.github/workflows/playwright.yml` runs the suite on every push/PR and uploads four artifacts:

- `playwright-report` — native HTML report
- `allure-results` — raw JSON
- `allure-report` — pre-built Allure dashboard
- `ai-reports` — the markdown execution summaries

Wire `ANTHROPIC_API_KEY` and any test credentials in GitHub repo Secrets if you want CI to use the AI generator or run AC1 verified logins.

---

## Where to get help

1. **README.md** in this folder — architecture overview
2. **QAEnd2EndPromptFile.md** — the workflow prompts (Express + 7 detailed steps)
3. **pages/README.md** — POM conventions
4. **reports/** — example execution reports and the heal demo

If something is broken or unclear, open an issue in the team repo, or ping in #qa-automation Slack.

---

## TL;DR for the impatient

```bash
git clone <repo-url> && cd agentic-qa
npm run setup
npm run ui
# → http://localhost:3001 → paste URL + story → ✨ Generate & Run
```

That's it. Welcome to the team.
