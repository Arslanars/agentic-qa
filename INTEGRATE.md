# Integrating agentic-qa into an existing Playwright project

This guide is for **teammates with an existing Playwright repo** who want to add the AI-powered generator, UI, and report pipeline without restructuring anything they already have.

You keep your existing `tests/`, `pages/`, and `playwright.config.js`. The framework slots in alongside them.

---

## Prerequisites

- Node.js 18+
- An existing Playwright project (yours)
- (Optional) Anthropic API key — only needed for the **✨ Generate** button in the UI
- (Optional) Java 8+ — only needed for local Allure HTML rendering (CI doesn't need it)

---

## 1. Install (one command)

```bash
# from the root of your Playwright project
npm install --save-dev github:<your-org>/agentic-qa
```

Or if you've cloned this repo locally, install from a path:

```bash
npm install --save-dev /absolute/path/to/agentic-qa
```

---

## 2. Initialize

```bash
npx agentic-qa init
```

This is idempotent — safe to re-run. It will:

| What | Where | Note |
|------|-------|------|
| Create `agentic-qa.config.js` | repo root | Tweak paths/port/model here |
| Drop in `BasePage.ts` | `pages/BasePage.ts` (or your `pagesDir`) | The abstract base every POM extends |
| Create empty `user-stories/`, `specs/`, `reports/` | repo root | With `.gitkeep` |
| Drop in `.claude/agents/` | repo root | Planner / generator / healer agent prompts for Claude Code users |
| Create `.env.example` | repo root | Lists optional env vars; copy to `.env` to fill in |
| Append entries to `.gitignore` | repo root | Excludes runtime artifacts |
| Add npm scripts | `package.json` | `qa`, `qa:ui`, `qa:generate`, `qa:run` |

Existing files are **never overwritten** without `--force`.

---

## 3. Manual step — patch your `playwright.config`

The init command **does not auto-edit your Playwright config** — too risky. Merge these two snippets into your existing `defineConfig({...})`:

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
# edit .env — add ANTHROPIC_API_KEY if you want the Generate button
```

---

## 5. Run it

```bash
npm run qa:ui
```

Opens `http://localhost:3001`. Pick a feature from the dropdown, click **▶ Run Tests**.

If you have existing tests under `tests/<feature>/*.spec.ts`, those will appear in the dropdown automatically. The framework reads from your existing layout.

---

## How it fits into your project

| Your existing thing | Stays | What changes |
|--------------------|-------|--------------|
| `tests/` | ✅ | Nothing |
| `pages/` | ✅ | One file added: `BasePage.ts` (only if missing) |
| `playwright.config.js` | ✅ | You manually add 2 reporters + 2 `use` options |
| `package.json` | ✅ | 4 scripts added under `qa:*` |
| `.gitignore` | ✅ | Runtime artifact entries appended |
| Your CI | ✅ | Wire `npm run qa:run` if you want; existing CI keeps working |

| New things added | Owned by you (commit it) |
|-----------------|--------------------------|
| `agentic-qa.config.js` | ✅ yes |
| `user-stories/*.md` | ✅ yes (this is your input) |
| `specs/*.md` (AI test plans) | ✅ yes |
| `reports/*.md` (AI exec reports) | ✅ yes |
| `pages/BasePage.ts` | ✅ yes |
| `pages/<feature>/*Page.ts` (generated POMs) | ✅ yes |
| `tests/<feature>/*.spec.ts` (generated tests) | ✅ yes |

---

## CLI reference

```bash
npx agentic-qa init             # one-time bootstrap
npx agentic-qa ui                # launch http://localhost:3001
npx agentic-qa ui --port 4001    # alternate port
npx agentic-qa generate \        # CLI generation (CI-friendly)
  --url https://app.com/login \
  --story user-stories/LOGIN-001.md
npx agentic-qa generate \        # or inline
  --url https://app.com/login \
  --title "User authentication" \
  --ac "AC1: ..."
npx agentic-qa run --feature login --headed   # delegates to playwright test
```

All commands honor `agentic-qa.config.js` in the cwd.

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

### The "✨ Generate" button says "ANTHROPIC_API_KEY is not set"

Add the key to your `.env` file at the repo root, then restart `npm run qa:ui`. The dotenv-style file is read on server start.

### Allure link 404s

Java isn't installed. The Playwright HTML report and AI markdown reports still work. To enable Allure locally: `winget install Microsoft.OpenJDK.21` (Windows), `brew install openjdk` (macOS), or `apt install default-jdk` (Linux). Then restart `qa:ui`.

### Tests fly past in headed mode

The framework forces `--workers=1` for headed runs so each browser session is visible end-to-end. If they still seem fast, that's because Playwright is fast — try unchecking ☑ Headed and rely on the screenshots gallery for evidence.

---

## What the UI does that's different

When you click ▶ **Run Tests**, the framework:

1. Wipes `allure-results/` so the report reflects only this run
2. Runs `npx playwright test` with your config + `--workers=1` if headed
3. Streams NDJSON to the browser (live log)
4. Auto-rebuilds the Allure HTML report
5. Surfaces a screenshots gallery from the freshly-captured `test-results/` PNGs
6. Updates the report links in the footer (Playwright HTML / Allure / AI markdown)

When you click ✨ **Generate & Run**, it adds two steps before the above:

0a. Headless Chromium explores the URL, captures the accessibility tree + form controls + validation messages
0b. Sends that snapshot + your story to Claude Opus 4.8 (adaptive thinking, JSON-schema output), writes the POM + spec files

Nothing about your existing setup is replaced — these are additive.
