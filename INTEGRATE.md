# Integrating agentic-qa into an existing Playwright project

This guide is for **teammates with an existing Playwright repo** who want to add the visual test runner, POM convention, and Allure pipeline without restructuring anything they already have.

You keep your existing `tests/`, `pages/`, and `playwright.config.js`. The framework slots in alongside them.

---

## Prerequisites

- Node.js 18+
- An existing Playwright project (yours)
- (Optional) Java 8+ — only needed for local Allure HTML rendering (CI doesn't need it)
- (Optional) Claude Code — only needed if you want AI-assisted authoring (uses your subscription, not a paid API)

---

## 1. Install (one command)

```bash
# from the root of your Playwright project
npm install --save-dev github:<your-org>/agentic-qa
```

Or if you've cloned this repo locally:

```bash
npm install --save-dev /absolute/path/to/agentic-qa
```

---

## 2. Initialize

```bash
npx agentic-qa init
```

Idempotent — safe to re-run. It will:

| What | Where | Note |
|------|-------|------|
| Create `agentic-qa.config.js` | repo root | Tweak paths/port here |
| Drop in `BasePage.ts` | `pages/BasePage.ts` (or your `pagesDir`) | The abstract base every POM extends |
| Create empty `user-stories/`, `specs/`, `reports/` | repo root | With `.gitkeep` |
| Drop in `.claude/agents/` | repo root | Planner / generator / healer agent prompts for Claude Code |
| Create `.env.example` | repo root | Lists optional credential vars |
| Append entries to `.gitignore` | repo root | Excludes runtime artifacts |
| Add npm scripts | `package.json` | `qa`, `qa:ui`, `qa:run` |

Existing files are **never overwritten** without `--force`.

---

## 3. Manual step — patch your `playwright.config`

The init command **does not auto-edit your Playwright config** — too risky. Merge these snippets into your existing `defineConfig({...})`:

```js
// playwright.config.js (or .ts)
module.exports = defineConfig({
  // ...your existing config...

  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    ['allure-playwright', {
      detail: true,
      outputFolder: 'allure-results',
      suiteTitle: false,
    }],
  ],

  use: {
    // ...your existing use options...
    screenshot: 'on',           // populates the UI's screenshots gallery
    video: 'retain-on-failure', // for debugging failures
  },
});
```

---

## 4. (Optional) Wire credentials

```bash
cp .env.example .env
# edit .env — add any per-feature credentials your specs reference
```

---

## 5. Run it

```bash
npm run qa:ui
```

Opens `http://localhost:3001`. Pick a feature from the dropdown, click ▶ **Run Tests**.

Existing tests under `tests/<feature>/*.spec.ts` appear in the dropdown automatically.

---

## How it fits into your project

| Your existing thing | Stays | What changes |
|--------------------|-------|--------------|
| `tests/` | ✅ | Nothing |
| `pages/` | ✅ | One file added: `BasePage.ts` (only if missing) |
| `playwright.config.js` | ✅ | You manually add 2 reporters + 2 `use` options |
| `package.json` | ✅ | 3 scripts added under `qa:*` |
| `.gitignore` | ✅ | Runtime artifact entries appended |
| Your CI | ✅ | Wire `npm run qa:run` if you want; existing CI keeps working |

| New things added | Owned by you (commit it) |
|-----------------|--------------------------|
| `agentic-qa.config.js` | ✅ |
| `user-stories/*.md` | ✅ |
| `specs/*.md` (test plans) | ✅ |
| `reports/*.md` (execution reports) | ✅ |
| `pages/BasePage.ts` | ✅ |
| `pages/<feature>/*Page.ts` | ✅ |
| `tests/<feature>/*.spec.ts` | ✅ |

---

## CLI reference

```bash
npx agentic-qa init             # one-time bootstrap
npx agentic-qa ui                # launch http://localhost:3001
npx agentic-qa ui --port 4001    # alternate port
npx agentic-qa run --feature login --headed   # delegates to playwright test
```

All commands honor `agentic-qa.config.js` in the cwd.

For test authoring, use Claude Code with the prompts in [QAEnd2EndPromptFile.md](QAEnd2EndPromptFile.md), or hand-author following [pages/README.md](pages/README.md).

---

## Upgrading

```bash
npm update agentic-qa
npx agentic-qa init  # re-runs init (idempotent); new templates land, your files stay
```

---

## Uninstalling

```bash
npm uninstall agentic-qa
# Optionally delete: agentic-qa.config.js, .claude/agents/, user-stories/, specs/, reports/
# Your tests/, pages/ (except BasePage.ts if you want), and playwright.config stay yours.
```

---

## Troubleshooting

### `npm run qa:ui` says "address in use"

Port 3001 is taken. Either pass `--port 3002` or set `uiPort: 3002` in `agentic-qa.config.js`.

### Allure link 404s

Java isn't installed. The Playwright HTML report and markdown reports still work. To enable Allure locally: `winget install Microsoft.OpenJDK.21` (Windows), `brew install openjdk` (macOS), or `apt install default-jdk` (Linux). Then restart `qa:ui`.

### Tests fly past in headed mode

The framework forces `--workers=1` for headed runs so each browser session is visible end-to-end. If they still seem fast, that's because Playwright is fast — try unchecking ☑ Headed and rely on the screenshots gallery for evidence.

---

## What the UI does when you click ▶ Run Tests

1. Wipes `allure-results/` so the report reflects only this run
2. Runs `npx playwright test` with your config + `--workers=1` if headed
3. Streams NDJSON to the browser (live log)
4. Auto-rebuilds the Allure HTML report
5. Surfaces a screenshots gallery from the freshly-captured `test-results/` PNGs
6. Updates the report links in the footer (Playwright HTML / Allure / markdown reports)

Nothing about your existing setup is replaced — these are additive.
