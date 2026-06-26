# Agentic QA Automation Pipeline

A structured Playwright framework with a **visual test runner**, **Page Object Model conventions**, and **Allure + Playwright reporting** — wired up so you (or Claude Code) can turn a user story into executable browser tests and watch them run.

> **No paid API required.** Test authoring is done either by hand or via your existing Claude Code subscription. The UI ships zero AI features that need a third-party key.

---

## What you get

| Capability | How |
|------------|-----|
| Visual test runner with live NDJSON streaming | `npm run ui` → http://localhost:3001 |
| Browser-headed runs you can actually watch | `--workers=1` enforced for headed mode |
| Auto-rebuilt Allure HTML after every run | Built-in when Java is installed |
| Screenshots gallery from the latest run | Click thumbnails for full-size lightbox |
| POM convention with shared `BasePage` | `pages/<feature>/<Name>Page.ts` |
| AI-driven test authoring (via Claude Code) | Reusable prompts in [QAEnd2EndPromptFile.md](QAEnd2EndPromptFile.md) |
| Self-healing for broken locators | Done manually via Claude Code's MCP browser tools |
| CI workflow | [.github/workflows/playwright.yml](.github/workflows/playwright.yml) |

---

## How a feature gets tested

```
┌──────────────┐    ┌──────────────┐    ┌────────────────┐    ┌──────────┐    ┌────────────┐    ┌──────────┐
│  User story  │ -> │  Test plan   │ -> │  Exploratory   │ -> │ Generate │ -> │  Execute   │ -> │  Report  │
│  + AC (.md)  │    │  (planner)   │    │  testing (MCP) │    │  scripts │    │            │    │  (.md)   │
└──────────────┘    └──────────────┘    └────────────────┘    └──────────┘    └────────────┘    └──────────┘
       ↑                                                                            ↑
   Form in UI                                                                    UI ▶ Run
   or `_TEMPLATE.md`                                                             button
```

**Authoring (the planning + scripting part):** drive the Claude Code agents in [.claude/agents/](.claude/agents/) using the prompts in [QAEnd2EndPromptFile.md](QAEnd2EndPromptFile.md). Those agents use the Playwright MCP server to explore the live app, write POMs, and write specs — using your Claude Code subscription, no separate API key.

**Running (the part you do every day):** open the UI, pick a feature, click ▶ Run Tests. Watch the visible browser, inspect screenshots, click into reports.

---

## Repo layout

```
.
├── .claude/
│   └── agents/                    # Planner / generator / healer agent prompts (Claude Code)
├── .github/workflows/
│   └── playwright.yml             # CI: runs the suite on push/PR
├── .vscode/
│   └── mcp.json                   # VSCode MCP server config (playwright)
├── user-stories/                  # INPUT: one .md per user story
│   └── _TEMPLATE.md
├── specs/                         # Test plans (markdown) — output of the planner
├── pages/                         # Page Object Model — one class per page
│   ├── BasePage.ts
│   └── <feature>/<PageName>Page.ts
├── tests/                         # Playwright specs
│   └── <feature>/*.spec.ts
├── reports/                       # Execution summaries (markdown)
├── test-results/                  # Playwright runtime artifacts (gitignored)
├── ui/                            # Visual test runner (`npm run ui`)
│   ├── server.js                  #   Express server with NDJSON streaming
│   └── index.html                 #   Form + live log + reports + screenshots
├── playwright.config.js           # chromium / firefox / webkit projects
├── QAEnd2EndPromptFile.md         # Reusable Claude Code prompts (Express + 7-step)
└── README.md
```

---

## Quickstart

### 1. One-time setup
```bash
npm install
npx playwright install
```

### 2. Run the UI
```bash
npm run ui
# → http://localhost:3001
```

- If `tests/<feature>/*.spec.ts` already exists, those features show up in the dropdown automatically.
- Click ▶ **Run Tests** → Playwright opens a Chromium window and runs each test you can watch.
- Reports appear as clickable links in the footer when the run finishes.

### 3. Add a new feature

**Option A — Claude Code (recommended):**
1. Open this folder in Claude Code.
2. Paste the Express Prompt from [QAEnd2EndPromptFile.md](QAEnd2EndPromptFile.md), filled with your URL + title + ACs.
3. Claude derives the story ID + slug, generates POMs + specs, writes them to disk.
4. Reload the UI — the new feature appears in the dropdown.

**Option B — Manual:**
1. Click **Save Story** in the UI to write `user-stories/<id>-<slug>.md`, or copy `user-stories/_TEMPLATE.md`.
2. Hand-author `pages/<slug>/<Name>Page.ts` extending `BasePage`.
3. Hand-author `tests/<slug>/*.spec.ts`.
4. Reload the UI, pick the feature, ▶ Run.

---

## Running tests

```bash
npm test                       # all browsers
npm run test:chromium          # chromium only
npm run test:ui                # interactive Playwright UI mode
npm run test:headed            # show the browser
npm run test:report            # open the Playwright HTML report
```

### Allure report (rich UI, trends, history)

Each run emits raw Allure JSON into `allure-results/`. The UI rebuilds the HTML report automatically if Java is installed.

```bash
npm run allure:serve           # one-shot: build + open
npm run allure:generate        # write static HTML to allure-report/
npm run allure:open            # open the static report
npm run allure:clean           # wipe results + report
```

> **Prereq (local only):** Allure CLI needs Java. Install once: `winget install Microsoft.OpenJDK.21` (Windows), `brew install openjdk` (macOS), or `apt install default-jdk` (Linux). CI runners already ship Java.
>
> Even without Java, `allure-results/` JSON is still written every run — you can upload it to a hosted Allure server.

---

## CI

`.github/workflows/playwright.yml` runs the suite on push/PR and uploads four artifacts:

- `playwright-report` — native Playwright HTML
- `allure-results` — raw Allure JSON
- `allure-report` — pre-built Allure HTML
- `reports` — markdown execution summaries

Wire test credentials via GitHub Secrets if your specs read from `process.env`.

---

## Page Object Model — at a glance

```typescript
// pages/auth/LoginPage.ts
import { type Locator, type Page } from '@playwright/test';
import { BasePage } from '../BasePage';

export class LoginPage extends BasePage {
  readonly url = 'https://example.com/login';
  readonly emailInput: Locator;
  readonly submitButton: Locator;

  constructor(page: Page) {
    super(page);
    this.emailInput = page.getByRole('textbox', { name: 'Email' });
    this.submitButton = page.getByRole('button', { name: 'Sign In' });
  }

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

A UI change touches one file (the page object), not every test. Full conventions in [pages/README.md](pages/README.md).

---

## Tech stack

- [Playwright](https://playwright.dev) — browser automation + test runner
- [Playwright MCP](https://github.com/microsoft/playwright-mcp) — browser tools for the Claude Code agents
- [Allure](https://docs.qameta.io/allure/) — rich HTML reports
- [Express](https://expressjs.com) — UI server
- Claude Code (subscription) — optional authoring path

---

## License

ISC
