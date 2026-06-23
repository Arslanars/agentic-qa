# Agentic QA Automation Pipeline

An AI-driven solution that converts user stories into executable Playwright automation scripts and produces a structured execution summary report — without manual scripting.

> **MVP focus:** user story → scenarios → Playwright tests → execution → AI summary report. Self-healing and multi-agent orchestration are included as bonus features.

---

## Why this exists

Manually turning requirements into Playwright tests is slow, repetitive, and inconsistent:

- Manual conversion of requirements into automation scripts
- Slow automation onboarding for new features
- High script maintenance effort
- Limited time for exploratory testing
- Manual preparation of execution reports

This pipeline collapses those steps into a single guided workflow driven by Claude + Playwright MCP.

---

## How it works

```
┌──────────────┐    ┌──────────────┐    ┌────────────────┐    ┌──────────┐    ┌────────────┐    ┌──────────┐
│  User story  │ -> │  Test plan   │ -> │  Exploratory   │ -> │ Generate │ -> │  Execute   │ -> │  Report  │
│  + AC (.md)  │    │  (planner)   │    │  testing (MCP) │    │  scripts │    │ (& heal)   │    │  (.md)   │
└──────────────┘    └──────────────┘    └────────────────┘    └──────────┘    └────────────┘    └──────────┘
```

Each phase is driven by a specialized agent (see [.claude/agents/](.claude/agents/)):

| Agent | Role | Output |
|-------|------|--------|
| `playwright-test-planner` | Explores the live app, designs positive/negative/edge scenarios | `specs/<feature>-test-plan.md` |
| `playwright-test-generator` | Converts the plan into Page Object classes + Playwright TypeScript tests | `pages/<feature>/*.ts` and `tests/<feature>/*.spec.ts` |
| `playwright-test-healer` | Re-runs failing tests, fixes selectors/timing/assertions | Updated `*.spec.ts` |

The full prompt sequence used to drive the pipeline lives in [QAEnd2EndPromptFile.md](QAEnd2EndPromptFile.md).

---

## Repo layout

```
.
├── .claude/
│   └── agents/                    # Planner / generator / healer agent definitions
├── .github/workflows/
│   └── playwright.yml             # CI: runs the suite on push/PR
├── .vscode/
│   └── mcp.json                   # VSCode MCP server config (playwright + github)
├── user-stories/                  # INPUT: one .md per user story
│   └── _TEMPLATE.md               # Copy this if you prefer the step-by-step flow
├── specs/                         # OUTPUT 1: planner-generated test plans
├── pages/                         # Page Object Model — one class per page (see pages/README.md)
│   ├── BasePage.ts
│   └── <feature>/<PageName>Page.ts
├── tests/                         # OUTPUT 2: generated Playwright tests (use the POMs above)
│   └── <feature>/*.spec.ts
├── reports/                       # OUTPUT 3: execution summary + exploratory findings
├── test-results/                  # Playwright runtime artifacts (gitignored, auto-cleared each run)
├── ui/                            # Single-page web app for visual demos (`npm run ui`)
│   ├── server.js                  #   Express server with NDJSON streaming
│   └── index.html                 #   Form + live log + report links
├── playwright.config.js           # chromium / firefox / webkit projects
├── QAEnd2EndPromptFile.md         # The 7-step workflow prompts (reusable)
└── README.md
```

---

## Quickstart — URL + user story is all you need

### 1. One-time setup
```powershell
npm install
npx playwright install
```

### 2. Two ways to drive the pipeline

#### Option A — Web UI (visual demo)
```powershell
npm run ui
```
Opens http://localhost:3001 — a single-page app where you paste URL + user story, pick a feature, and click **Run Tests**. Playwright opens in headed mode so you watch the browser execute the tests live. Reports (Playwright HTML, Allure, AI markdown) appear as clickable links when the run finishes.

> The UI runs *existing* tests in a visible browser. To generate tests for a brand-new story, click **Save Story**, copy the Express prompt shown, paste it into Claude Code, and reload the UI when generation finishes.

#### Option B — Claude Code Express Prompt (full AI generation)
Open this folder in Claude Code and paste the Express Prompt from [QAEnd2EndPromptFile.md](QAEnd2EndPromptFile.md). Replace the placeholders with:

- Application URL
- One-line story title
- Acceptance criteria (Given/When/Then)
- *(optional)* test credentials

Claude derives the story ID, feature slug, and every file path automatically — then runs the full pipeline. Either option produces:

| File | What it is |
|------|-----------|
| `user-stories/<STORY-ID>-<feature-slug>.md` | Your story, formalized |
| `specs/<feature-slug>-test-plan.md` | Test plan with positive/negative/edge scenarios |
| `pages/<feature-slug>/<PageName>Page.ts` | Page objects (POM) |
| `tests/<feature-slug>/*.spec.ts` | Playwright tests using the POMs |
| `reports/<STORY-ID>-<feature-slug>-test-report.md` | AI execution summary report |

### 4. Run tests locally
```powershell
npm test                       # all browsers (chromium, firefox, webkit)
npm run test:chromium          # chromium only
npm run test:ui                # interactive UI mode
npm run test:report            # open the Playwright HTML report
```

#### Allure report (rich UI, trends, history)

Every test run also emits Allure results into `allure-results/` (raw JSON). To view the HTML report:

```powershell
npm run allure:serve           # one-shot: build + open a temporary report
# or
npm run allure:generate        # write static HTML to allure-report/
npm run allure:open            # open the static report in a browser
npm run allure:clean           # wipe results and report folders
```

Allure surfaces per-test steps, attachments (screenshots/traces), suite breakdowns, and trend graphs across runs.

> **Prerequisite (local only):** the Allure CLI runs on Java. If you don't have Java installed, the `allure:generate / open / serve` commands will fail with `JAVA_HOME is set to an invalid directory`. CI is unaffected because Ubuntu runners ship with Java.
>
> Install once on Windows:
> ```powershell
> winget install --id Microsoft.OpenJDK.21
> # then restart your shell so JAVA_HOME / PATH refresh
> ```
> Or download Temurin/OpenJDK from <https://adoptium.net>. Java 8 or newer is sufficient.
>
> Even without Java locally, the `allure-results/` JSON files are still written on every test run — you can upload them to a hosted Allure server or view them in CI.

### 5. Run in CI
Push or open a PR — [.github/workflows/playwright.yml](.github/workflows/playwright.yml) runs the suite and uploads four artifacts:

- `playwright-report` — the native Playwright HTML report
- `allure-results` — raw Allure JSON results (re-generatable)
- `allure-report` — pre-built Allure HTML report
- `ai-reports` — the AI execution summary report and exploratory findings

Wire real credentials via GitHub Secrets.

### Alternative: step-by-step
If you want full control or to learn the pipeline, the [user-stories/_TEMPLATE.md](user-stories/_TEMPLATE.md) + the 7 individual prompts in [QAEnd2EndPromptFile.md](QAEnd2EndPromptFile.md) get you the same result with no auto-derivation.

---

## Page Object Model

All generated tests use POM — locators and interactions live in `pages/<feature>/<PageName>Page.ts`, classes extend [`pages/BasePage.ts`](pages/BasePage.ts). Full conventions and examples are in [pages/README.md](pages/README.md).

In short:

```typescript
// pages/auth/LoginPage.ts
export class LoginPage extends BasePage {
  readonly url = 'https://example.com/login';
  readonly emailInput = this.page.getByRole('textbox', { name: 'Email' });
  readonly submitButton = this.page.getByRole('button', { name: 'Sign In' });

  async login(email: string, password: string) {
    await this.emailInput.fill(email);
    // …
  }
}

// tests/auth/login.spec.ts
test('happy path', async ({ page }) => {
  const loginPage = new LoginPage(page);
  await loginPage.goto();
  await loginPage.login('user@x.com', 'secret');
});
```

A UI change touches one file (the page object), not every test.

---

## Example execution summary

Every generated report starts with a strict summary block. After your first run you'll see something like:

```
Total tests:     4
Passed:          4
Failed:          0
Failure reason:  None
```

For runs with failures, the same block names the cause in one line — no scrolling through stack traces to find the headline.

---

## Mapping to project objectives

| Objective (from project brief) | Where it lives |
|-------------------------------|----------------|
| User story → Playwright test generation | Planner + generator agents, driven via [QAEnd2EndPromptFile.md](QAEnd2EndPromptFile.md) |
| Execution of generated tests | `npm test`, `mcp__playwright-test__test_run`, CI workflow |
| AI-generated summary report | `reports/<STORY-ID>-*-test-report.md` (strict format at top) |
| Positive / negative / edge scenarios | Test plan suites cover all three classes |
| Scenario list as a distinct output | "Test Scenarios" section in each test plan |
| Playwright script output | `tests/<feature>/*.spec.ts` — ready to run |
| Execution summary (Total/Passed/Failed/Reason) | Top of every report |
| **Bonus** — test execution integration | Native via Playwright MCP `test_run` |
| **Bonus** — self-healing logic | `playwright-test-healer` agent |
| **Bonus** — GitHub Actions integration | `.github/workflows/playwright.yml` |
| **Bonus** — code quality | Role-based selectors, env-var creds, `expect()` assertions, test hooks |

---

## What it does NOT try to do

In line with the project scope limits:

- It does **not** auto-fix arbitrary application bugs — only failing test code (via healer agent)
- It does **not** chain dozens of micro-agents — only three specialized ones (planner / generator / healer)
- It does **not** ship a custom UI — Claude Code is the interface
- It does **not** require API keys to a separate LLM provider — runs via the Claude Code harness

---

## Tech stack

- [Playwright](https://playwright.dev) for browser automation and test runner
- [Playwright MCP](https://github.com/microsoft/playwright-mcp) for live browser tools accessible to the agent
- Claude Code (Anthropic) for orchestrating the agents and producing the report
- GitHub Actions for CI

---

## License

ISC
