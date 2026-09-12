# Agentic QA Automation Pipeline — working rules

Local Playwright + playwright-bdd framework with a visual runner UI. This file is
loaded automatically on every turn, so the conventions below do **not** need to be
rediscovered by reading `QAEnd2EndPromptFile.md`, `features/README.md` or
`pages/README.md` first. Read those only when you need detail beyond this.

## Layout

| Path | What |
|---|---|
| `features/<slug>/<name>.feature` | Gherkin — the source of truth |
| `features/<slug>/<name>.steps.ts` | Step definitions (thin; wrap POMs) |
| `features/<slug>/testcases.json` | Test-case metadata for the Excel report |
| `features/_shared/` | Steps available to **every** feature |
| `pages/<slug>/<Name>Page.ts` | Page objects, extend `pages/BasePage.ts` |
| `user-stories/<STORY-ID>-<slug>.md` | The story + acceptance criteria |
| `specs/` | Plans and drafts (never executed) |
| `.features-gen/` | **Generated** by bddgen — never edit, never commit |
| `reports/`, `test-results/`, `allure-*` | **Generated** output — never hand-edit |

## Hard rules

1. **Gherkin is the only authoring path.** Never write a raw `.spec.ts` test.
2. **Steps wrap page objects.** Never call `page.locator(...)` inside a step file;
   put the locator on the POM.
3. **Locate by role + accessible name**: `page.getByRole('button', { name: 'Sign In' })`.
   Locators are `readonly Locator` properties initialised in the constructor.
4. **Step definitions are tag-scoped** and this is load-bearing:
   ```ts
   const { Given, When, Then } = createBdd(undefined, { tags: '@login' });
   ```
   A step defined under `@login` is **not** available to an `@order-flow` scenario.
   `features/_shared/` uses bare `createBdd()` and is global. Before adding a step,
   check whether the phrase already exists *in the same tag scope* — the UI exposes
   this at `GET /api/steps` and `POST /api/steps/match`.
5. **Do not run `npx bddgen`.** The server runs it in Node after generation.
6. **Scenario names carry the test ID**: `Scenario: AC1-NEG-03 — empty email is rejected`.
   The Excel and markdown reports key off these IDs.
7. **`@destructive`** marks scenarios that do real, irreversible things (send real
   vendor orders, create real accounts). They are excluded from every UI run.
   Never remove the tag, and never write a new destructive scenario unasked.
8. **Prefer `Scenario Outline` + `Examples:`** over near-duplicate scenarios.

## Generation behaviour (user's standing preferences)

- **Review the existing structure before writing.** Search first; reuse over recreate.
- **Update in place — do not regenerate.** Never delete and rebuild a feature that
  already exists; amend it. Preserve scenarios that still apply.
- **No duplicates.** Reuse an existing step phrase or POM method if one fits.
- **Minimal edits.** Touch only what the change requires.
- **Fix, don't rebuild.** A failing test gets a targeted fix.
- **Ask when genuinely ambiguous** rather than guessing at intent.
- **Fail loudly on unmet acceptance criteria** — do not quietly drop an AC.

## App under test (Moontower)

Live third-party app at `https://moontower.aiimone.com`. It is **non-deterministic** —
tests hit a real system, so:

- A `role=status` "Loading" splash covers the page until React hydrates; cold start
  runs 8–15s. Gate on the splash clearing before asserting, and give first-paint
  assertions a ~15s budget. Default 5s expectations flake here.
- The whole authenticated surface is gated behind a **location choice**
  (`/select-location` → "Main Location"). A full page load loses it — the selection
  lives in in-memory React state, only `localStorage.moontower_token` persists.
- Login posts to `…/api/Auth/Login` and routes client-side with **no navigation
  event**. Wait for the response, then for the URL to change.

## Checks before you finish

- `npx playwright test --list` still collects every test.
- `node --check` passes on any `.js` you edited (`ui/server.js` is CommonJS).
- You did not edit `.features-gen/`, `reports/`, or anything gitignored.
