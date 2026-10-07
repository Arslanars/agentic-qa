# Agentic QA Automation Pipeline

A local **Playwright + BDD** framework with a **visual test-runner UI**. Turn user stories into
executable browser tests, auto-heal failures, track flakiness, and run security/API/performance checks —
all from one dashboard.

> **No paid API required.** AI features (generate / heal / explain / review) run through your local
> `claude` CLI. Everything else is pure Node + Playwright — no third-party keys.

```
Story + ACs  →  Generate (.feature + steps + POM)  →  Run  →  Heal on failure  →  Reports
                         ↑ Coverage gaps        ↑ Tags · PR-impact · Scheduled · Flaky
```

---

## Features

- **Story → Tests** — paste ACs; Claude drafts the `.feature`, `.steps.ts`, and Page Objects to match your project style.
- **Spec Doctor** — lints ACs for vague verbs, missing negatives, and un-measurable outcomes before you generate.
- **Coverage Gap Detector** — per-AC ✓/✗ with one-click auto-fill for uncovered criteria.
- **Test Recorder** — Playwright codegen captured straight into Gherkin.
- **Visual runner** — live step timeline, log streaming, screenshot gallery, run history + ETA, light/dark theme.
- **Failure Triage** — **Heal** (Claude fixes the test) and **Explain** (plain-English bug narrative) per failure.
- **Tags · Tag Filter · Scheduled Runs · PR Impact Radar · Flaky Detection** — decide *what* to run and *when*.
- **Security scanner** — passive (headers/cookies/TLS/CORS) + active probes (XSS, SQLi, open redirect), optional OWASP ZAP, A–F risk grade, AI remediation review.
- **API & Performance** — request-level API suites with assertions/variable capture; real Web Vitals graded against budgets.
- **Reports** — Playwright HTML, Allure, Markdown summaries, and a master `Test-Cases.xlsx`.

---

## Setup

Requires **Node 20+**, **Git**, and (for AI features) the **`claude` CLI** on `$PATH` — https://claude.ai/download.

```bash
git clone https://github.com/Arslanars/agentic-qa.git
cd agentic-qa
npm install
npm run setup     # one-time: download Chromium / Firefox / WebKit (~400 MB)
npm run ui        # → http://localhost:3001
```

- **Into an existing Playwright project:** `npm i -D @arslanars/agentic-qa && npx agentic-qa init` — see `INTEGRATE.md`.
- **Without a Claude subscription:** everything non-AI works; AI actions return `501` with *"Claude CLI not detected"*.

---

## Quick start

1. **Open the UI** — `npm run ui` → http://localhost:3001
2. **Paste a story** — URL + Story ID + Acceptance Criteria (credentials optional).
3. **`Save & Generate Tests`** — Claude drafts the `.feature` + `.steps.ts` (~30s).
4. **`▶ Run Tests`** (`Ctrl+R`) — watch each Given/When/Then fill green in real time.
5. **On failure** — click the triage card → **Heal** fixes it, **Explain** writes a bug report.

---

## Running tests

```bash
npm test               # all browsers × all features
npm run test:chromium  # (or :firefox / :webkit)
npm run test:headed    # visible browsers
npm run test:ui        # Playwright interactive UI
npm run test:report    # open the HTML report
```

**Headless quality gates** (exit non-zero on failure — CI-ready):

```bash
npm run qa:security -- https://staging.example.com
npm run qa:perf     -- https://staging.example.com
npm run qa:api      -- auth.json
```

Keyboard: `Ctrl+R` run · `Ctrl+.` stop · `Ctrl+F` search log · `Esc` close modal.

---

## Reports

| Artifact | Location |
|---|---|
| Playwright HTML (trace viewer) | `playwright-report/index.html` |
| Allure HTML (trends, history) | `allure-report/index.html` — `npm run allure:serve` (needs Java) |
| Markdown summaries | `reports/<Feature-Slug>.md` |
| Master spreadsheet | `reports/Test-Cases.xlsx` |

---

## Repo layout

```
user-stories/   INPUT — one .md per story
specs/          Test plans (planner output)
pages/          Page Object Model — BasePage + <feature>/<Name>Page.ts
features/       Gherkin — <feature>/<name>.feature + .steps.ts + testcases.json
api-tests/      API test suites (JSON)
lib/            security · api-testing · perf engines + CLI commands
ui/             Express server + single-file UI + live step reporter
reports/        Execution summaries, history, security/perf output
playwright.config.js   chromium / firefox / webkit + BDD compile
QAEnd2EndPromptFile.md  Reusable Claude Code prompts
```

The Express server (`ui/server.js`) exposes ~35 local `/api/*` endpoints the UI calls — see the file to script your own automations.

---

## Tech stack

[Playwright](https://playwright.dev) · [playwright-bdd](https://github.com/vitalets/playwright-bdd) (Cucumber/Gherkin) ·
[Playwright MCP](https://github.com/microsoft/playwright-mcp) · [Allure](https://docs.qameta.io/allure/) ·
[Express](https://expressjs.com) · Claude Code CLI.

---

**Author:** Arslan Tufail — framework, UI, backend, and Claude Code agent integration. · **License:** ISC
