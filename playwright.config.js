// @ts-check
import { defineConfig, devices } from '@playwright/test';
import { defineBddConfig } from 'playwright-bdd';

/**
 * playwright-bdd compiles every .feature file into a Playwright spec at
 * runtime under `.features-gen/` (gitignored). `defineBddConfig` returns
 * the dir where the generated specs land.
 *
 * Cucumber/Gherkin is now the SOLE authoring path — every browser project
 * below points at bddTestDir, so scenarios run identically on chromium /
 * firefox / webkit.
 */
const bddTestDir = defineBddConfig({
  // Author features under features/<feature>/<name>.feature.
  // Anything starting with `_` (e.g. `_TEMPLATE.feature`) is treated as a
  // scaffolding source and excluded.
  features: ['features/**/*.feature', '!features/**/_*.feature'],
  steps: ['features/**/*.steps.ts'],
});

/**
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  // tests/seed.spec.ts is a scratch file written by the Playwright MCP
  // planner_setup_page tool; it's not a real test and pollutes the count.
  testIgnore: ['**/seed.spec.ts'],
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* CI retries twice; locally we retry once so a transient timeout on a real
     app (DNS/cold-start/network blip) doesn't fail a whole run. A test that
     times out *twice* in a row is genuinely broken and stays surfaced. */
  retries: process.env.CI ? 2 : 1,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    ['json', { outputFile: 'test-results/results.json' }],
    ['allure-playwright', {
      detail: true,
      outputFolder: 'allure-results',
      suiteTitle: false,
    }],
  ],
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',

    /* Always capture a screenshot at the end of each test, plus on failure.
       The UI surfaces these as a gallery so you can verify validations visually. */
    screenshot: 'on',

    /* Keep videos for failed tests so you can replay what went wrong. */
    video: 'retain-on-failure',
  },

  /* One BDD project per browser — all share the generated test dir
     so any feature runs identically across chromium / firefox / webkit. */
  projects: [
    // 60s per-test timeout on chromium too — the moontower app's cold start
    // on a fresh connection routinely runs 8-15s; the default 30s leaves no
    // margin once a test has its own assertions on top. Tests that were
    // passing in ~9s on a warm run timed out cleanly at 30s on cold today.
    { name: 'chromium', testDir: bddTestDir, timeout: 60_000, use: { ...devices['Desktop Chrome']  } },
    // Firefox cold-start under parallel workers is consistently slower than
    // chromium/webkit on the moontower app — raise the per-test timeout
    // here only so the wider expectLoaded budget can absorb hydration cost.
    { name: 'firefox',  testDir: bddTestDir, timeout: 60_000, use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit',   testDir: bddTestDir, timeout: 60_000, use: { ...devices['Desktop Safari']  } },
  ],
});
