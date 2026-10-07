# Gherkin / Cucumber tests

This folder is the **BDD authoring path**. Author scenarios in plain-English Gherkin (`.feature`) — they're compiled into Playwright tests at runtime by [playwright-bdd](https://github.com/vitalets/playwright-bdd) and run side-by-side with the classic `tests/<feature>/*.spec.ts` tests.

| Where | What |
|-------|------|
| `features/<feature>/<name>.feature` | Gherkin scenarios (the source of truth, business-readable) |
| `features/<feature>/<name>.steps.ts` | Step definitions — map each step phrase to code. **Re-use existing POMs** from `pages/<feature>/<Name>Page.ts`. |
| `features/_TEMPLATE.feature` | Copy this to scaffold a new feature |

## Two layouts — which one am I in?

The paths above are the **single-site layout**: one application under test, its
features at the repo root. That is what `npx agentic-qa init` scaffolds and it
is fully supported.

Once a project tests **more than one application**, each gets a self-contained
folder and every path above gains a `sites/<site>/` prefix:

| Single-site | Multi-site |
|---|---|
| `features/<feature>/` | `sites/<site>/features/<feature>/` |
| `pages/<feature>/` | `sites/<site>/pages/<feature>/` |
| `user-stories/` | `sites/<site>/user-stories/` |
| `features/_shared/` | `sites/<site>/features/_shared/` (that site only) |

Both compile — `playwright.config.js` globs `features/**` *and*
`sites/*/features/**`. `pages/BasePage.ts` and `features/_shared/visual.steps.ts`
stay at the repo root either way: they are framework infrastructure shared by
every site. In the UI and its API a feature is then addressed as
`<site>/<feature>` (e.g. `moontower/login-user`).

**This repo uses the multi-site layout** — see `sites/moontower/`.

One caveat when you have several sites: a bare `createBdd()` in a site's
`_shared/` publishes those steps to **every** site's scenarios, because
Cucumber's step pool is global across everything bddgen compiles. Scope shared
steps to a site-level tag unless they are genuinely app-agnostic.

## Conventions

| Rule | Why |
|------|-----|
| One `.feature` per UI feature, mirroring `tests/<feature>/` | Easy to find both styles side by side |
| Step definitions wrap **existing POMs** — never `page.locator(...)` directly | Single source of truth for selectors |
| Destructive scenarios (create real prod accounts, send real money, etc.) live in the classic `.spec.ts` form behind an env-var gate | Gherkin should be safe to run in any environment |
| Test IDs in the Scenario name (e.g. `Scenario: AC1-NEG-03 — empty email is rejected`) | Excel + markdown reports reuse the same IDs |
| Use `Scenario Outline` with `Examples:` for parametric cases | Replaces 10 near-duplicate `.spec.ts` tests with one table |

## How it runs

```
features/<feature>/<name>.feature
       ↓ (bddgen compiles)
.features-gen/features/<feature>/<name>.feature.spec.js     (gitignored)
       ↓ (Playwright runs)
Same reporter, screenshots, traces, Excel pipeline as classic .spec.ts
```

- `bddgen` runs automatically before every `npm test*` script and every `/api/run` invocation. No separate compile step to remember.
- Every browser project (`chromium`, `firefox`, `webkit`) has `testDir` pointing at the BDD-generated dir, so `npm run test:chromium` (or picking `chromium` in the UI dropdown) executes every `.feature` scenario in chromium — no extra `--project` flags needed.

## Adding a new BDD feature in 5 steps

1. `cp features/_TEMPLATE.feature features/<feature-slug>/<name>.feature`
2. Replace the placeholders with your Feature/Scenarios.
3. Create the sibling `<name>.steps.ts` that maps each step phrase to code.
4. If a POM doesn't already exist for the feature, create one: `pages/<feature-slug>/<Name>Page.ts` extending `BasePage`.
5. Reload the UI — the new feature shows up in the dropdown with its `.feature` count. Click ▶ Run Tests.

## Example — step definition file

```typescript
import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { LoginPage } from '../../pages/login-user/LoginPage';

const { Given, When, Then } = createBdd();

Given('I am on the Moontower login page', async ({ page }) => {
  const login = new LoginPage(page);
  await login.goto();
  await login.expectLoaded();
});

When('I sign in with email {string} and password {string}',
  async ({ page }, email: string, password: string) => {
    const login = new LoginPage(page);
    await login.login(email, password);
  });

Then('I should be redirected to the location-picker screen', async ({ page }) => {
  await expect(page).toHaveURL(/\/select-location$/, { timeout: 15_000 });
});
```

## When to use BDD vs classic POM specs

Use **Gherkin** when:
- The scenarios will be reviewed / authored by non-engineers (product, manual QA, customer success).
- The same user flow has many parametric variants — `Scenario Outline` + `Examples:` collapses N near-duplicate specs into one table.
- The acceptance criteria language is already business-flavoured.

Use **classic POM `.spec.ts`** when:
- The test needs fine-grained TypeScript control (custom fixtures, dynamic imports, complex setup).
- The behaviour under test is intrinsically programmatic (sorting, retry logic, async state machines).
- Speed of authoring matters more than readability by stakeholders.

Both authoring styles share the same POMs and reports — feel free to mix per feature.
