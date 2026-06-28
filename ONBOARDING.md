# Onboarding — Agentic QA Pipeline

Welcome. This framework gives you a visual Playwright test runner, a Page Object Model convention, and Allure reporting — all from a single web UI.

**No paid API required.** Test authoring is done either by hand or via your existing Claude Code subscription.

You'll be productive in **under 5 minutes**.

---

## What you need

| Tool | Minimum version | Check |
|------|-----------------|-------|
| **Node.js** | 18+ | `node --version` |
| **Git** | any | `git --version` |
| (Optional) **Java JDK** | 8+ | `java -version` — needed only for local Allure HTML; CI/cloud doesn't need it |
| (Optional) **Claude Code** | any | Only if you want AI-assisted test authoring (uses your subscription) |

If `node` says 16 or older, install LTS from <https://nodejs.org>.

---

## Setup (one command)

```bash
git clone <repo-url> agentic-qa
cd agentic-qa
npm run setup
```

`npm run setup` does:

1. `npm install` — installs Playwright, Express, Allure CLI
2. `npx playwright install` — downloads Chromium/Firefox/WebKit (~300 MB, one-time)
3. Copies `.env.example` → `.env` (fill in any per-feature credentials)

Linux/macOS users may also need: `npx playwright install-deps` (system libs for Chromium).

---

## First run (60 seconds)

```bash
npm run ui
```

Open <http://localhost:3001>. The dropdown is empty on a fresh install — you haven't added any features yet.

If you already have a Playwright suite in `tests/<feature>/*.spec.ts`, it appears in the dropdown automatically. Pick it, click **▶ Run Tests**, watch the visible browser run.

You should see:

- A Chromium window pops up and runs each test in sequence
- The right panel streams `N passed (X.Xs)`
- The status badge flips green
- The screenshots gallery fills with thumbnails — click any to see the page state captured at the end of that test
- The footer shows links to the Allure, Playwright HTML, and markdown reports

That's the whole framework.

---

## What's where

```
.
├── ui/                       ← Web UI (Express + vanilla HTML/JS)
│   ├── server.js             ← API endpoints (run / save-story / screenshots / reports)
│   └── index.html            ← Single-page frontend
├── user-stories/             ← INPUT: drop new stories here as .md files
│   └── _TEMPLATE.md          ← Copy this for new stories
├── pages/                    ← Page Object Model classes (one per page)
│   ├── BasePage.ts
│   └── <feature>/<PageName>Page.ts
├── tests/                    ← Classic POM Playwright specs (one per AC)
│   └── <feature>/*.spec.ts
├── features/                 ← Cucumber/Gherkin scenarios (optional, runs alongside .spec.ts)
│   ├── _TEMPLATE.feature
│   ├── README.md             ← BDD authoring guide
│   └── <feature>/<name>.feature + <name>.steps.ts
├── specs/                    ← Test plans (markdown)
├── reports/                  ← Execution reports (markdown, committed)
├── test-results/             ← Playwright per-run artifacts (gitignored)
├── allure-results/           ← Raw Allure JSON (gitignored)
├── allure-report/            ← Allure HTML dashboard (gitignored, regenerated each run)
├── .features-gen/            ← BDD-compiled specs (gitignored, regenerated each run)
├── playwright.config.js
└── QAEnd2EndPromptFile.md    ← Reusable Claude Code prompts
```

---

## UI features

### Story Input form
Fill in URL, title, AC, optional credentials. Click **Save Story** to write `user-stories/<id>-<slug>.md`. The "Copy prompt" button copies the Express prompt pre-filled with your inputs — paste into Claude Code to scaffold POMs + specs.

### Feature dropdown + Run configuration
Pick a feature, browser, and whether to run headed. Click **▶ Run Tests**.

### Live log
NDJSON stream from `npx playwright test`. You see the same output you'd see in a terminal.

### Status bar
Real-time pill: `idle` / `running` / `pass` / `fail` plus `N passed`, `M failed`, total time.

### Screenshots gallery
Every test captures a screenshot at end. Click thumbnails for a lightbox.

### Reports footer
Quick links to:
- Playwright HTML report (`/playwright-report/`)
- Allure HTML report (`/allure-report/`)
- Markdown reports (`/reports-view/<file>`)

---

## Adding a new feature to test — four paths

### Path A: Use Claude Code (recommended)

1. Open this folder in Claude Code.
2. Open [QAEnd2EndPromptFile.md](QAEnd2EndPromptFile.md), copy the **Express Prompt** block at the top.
3. Paste into Claude Code with your URL + story + ACs filled in.
4. Claude generates everything; the new feature shows up in the UI dropdown on reload.
5. Click ▶ Run Tests.

This uses your Claude Code subscription — no separate API key needed.

### Path B: Save Story → hand-author classic POM specs

1. In the UI, fill in URL + title + AC.
2. Click **Save Story** — writes the `.md` file.
3. Hand-author `pages/<slug>/<Name>Page.ts` extending `BasePage`.
4. Hand-author `tests/<slug>/*.spec.ts` that import the POM.
5. Reload UI, ▶ Run.

### Path C: Cucumber / Gherkin (BDD)

1. Copy `features/_TEMPLATE.feature` to `features/<slug>/<name>.feature`.
2. Write Scenarios in plain English (`Given / When / Then`).
3. Create `features/<slug>/<name>.steps.ts` — wire each step phrase to code; reuse the same POM as classic specs.
4. Reload UI; the dropdown shows `<slug> (… .feature)`. ▶ Run.

Full BDD authoring guide: [features/README.md](features/README.md). When chromium is picked in the UI, both classic and Gherkin scenarios run together.

### Path D: Full hand-author from template

1. Copy `user-stories/_TEMPLATE.md` to `user-stories/<STORY-ID>-<slug>.md`.
2. Write the POM + specs (or `.feature` files).
3. Run via UI or `npm run test:chromium`.

POM conventions: [pages/README.md](pages/README.md).

---

## Self-healing pattern (manual, via Claude Code)

When the app's UI changes and a locator stops matching, the framework's `playwright-test-healer` agent (driven via Claude Code) inspects the live page, finds the correct selector, and patches one line in the POM. Specs are untouched.

To use it:

1. A test fails — open the per-test screenshot in the gallery to see the page as it actually is.
2. In Claude Code, invoke the `playwright-test-healer` agent on the failing test directory.
3. The agent runs the test, reads the broken locator, snapshots the live page, patches the POM, and re-runs.

A single edit can heal every spec that depends on that locator. That's the POM payoff.

---

## Environment variables

`.env.example` lists every variable. Copy to `.env` and fill in only what you need:

| Variable | Used for | Required? |
|----------|----------|-----------|
| `<APP>_*` (your own credentials) | Tests that need real auth — referenced via `process.env.<NAME>` | No |
| `UI_PORT` | Change UI server port from default `3001` | No |

---

## Common gotchas

- **"0 passed" or empty log on Run Tests** — hard-reload (Ctrl+F5). Cached old JS.
- **Headed mode doesn't show a browser** — make sure ☑ Headed is checked; on Linux you may need a display server (X / Xvfb) or use headless.
- **Allure link gives a 404 / report shows stale tests** — install Java (`winget install Microsoft.OpenJDK.21` on Windows). The Allure CLI is a Java tool.
- **Tests blink past in headed mode** — that's because 8 workers run in parallel. The UI already forces `--workers=1` for headed runs.

---

## CI

`.github/workflows/playwright.yml` runs the suite on every push/PR and uploads four artifacts:

- `playwright-report` — native HTML report
- `allure-results` — raw JSON
- `allure-report` — pre-built Allure dashboard
- `reports` — markdown execution summaries

Wire any test credentials via GitHub repo Secrets.

---

## Where to get help

1. **README.md** — architecture overview
2. **QAEnd2EndPromptFile.md** — the Claude Code workflow prompts (Express + 7-step)
3. **pages/README.md** — POM conventions
4. **reports/** — example execution reports

---

## TL;DR for the impatient

```bash
git clone <repo-url> && cd agentic-qa
npm run setup
npm run ui
# → http://localhost:3001 → pick feature → ▶ Run Tests
```

That's it. Welcome to the team.
