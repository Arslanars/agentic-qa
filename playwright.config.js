// @ts-check
import { defineConfig, devices } from '@playwright/test';
import { defineBddConfig } from 'playwright-bdd';
import { ALL_PROJECTS } from './ui/projects.js';

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
    // Custom reporter that streams per-step lifecycle events to stdout so
    // the UI can render the "Liquid Gherkin Step Timeline" — see
    // ui/live-step-reporter.js for the event shape.
    ['./ui/live-step-reporter.js'],
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
       The UI surfaces these as a gallery so you can verify validations visually.

       `style` is CSS injected only for the duration of the capture — it does not
       affect the page the test sees. It exists here because screenshots are `on`
       and the suite types real passwords into login/signup forms in ~36 places;
       without it every one of those shots recorded the password legibly, and
       they land in reports/, test-results/ and the UI screenshot gallery.
       Blur rather than hide so the shot still shows the field was filled.

       Selectors are deliberately wider than input[type=password]: this app has a
       show/hide toggle that flips the field to type="text", at which point that
       selector stops matching. Verified on the live login form — name="password"
       and id="password" both survive the toggle, so the blur holds either way. */
    screenshot: {
      mode: 'on',
      style: `
        input[type="password"],
        [name*="password" i],
        [id*="password" i],
        [data-testid*="password" i],
        [autocomplete="current-password"],
        [autocomplete="new-password"] {
          filter: blur(6px) !important;
        }
      `,
    },

    /* Keep videos for failed tests so you can replay what went wrong. */
    video: 'retain-on-failure',
  },

  /* One BDD project per browser/device — all share the generated test dir so
     any feature runs identically everywhere. The list lives in ui/projects.js
     so the UI's browser dropdowns cannot drift from what's defined here.

     60s per-test timeout across the board — the moontower app's cold start on
     a fresh connection routinely runs 8-15s; the default 30s leaves no margin
     once a test has its own assertions on top. Tests passing in ~9s warm timed
     out cleanly at 30s cold. Firefox cold-start under parallel workers is
     slower still, and the emulated device projects pay the same cost.

     The four device projects are emulation (viewport + DPR + UA + touch on a
     desktop WebKit/Chromium build), not an iOS Simulator or Android Emulator.
     They are deliberately excluded from the UI's "All browsers" matrix. */
  projects: ALL_PROJECTS.map((p) => ({
    name: p.name,
    testDir: bddTestDir,
    timeout: 60_000,
    use: { ...devices[p.device] },
  })),
});
