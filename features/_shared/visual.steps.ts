// Shared visual-regression step definitions.
//
// Usage in any .feature file (no tag required):
//
//   Then the "login-page" should match its visual baseline
//
// On the FIRST run, Playwright auto-creates the baseline screenshot under
// .features-gen/features/<feature>/<spec>.feature.spec.js-snapshots/. On
// subsequent runs the step fails if the rendered page differs from the
// baseline beyond Playwright's default `maxDiffPixelRatio`. When it fails,
// Playwright attaches expected/actual/diff PNGs to the test result; the
// existing /api/last-failures + triage UI picks those up automatically.
//
// To regenerate baselines after intentional UI changes:
//   npm run baselines:update
//
// The step is intentionally LEFT UNTAGGED so any feature can use it without
// opting into a tag scope. The step phrase is specific enough that it won't
// collide with feature-local step pools.

import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';

const { Then } = createBdd();

Then('the {string} should match its visual baseline', async ({ page }, name: string) => {
  // Wait for the page to settle before snapshotting — otherwise tests flake
  // on in-flight network / animations. `networkidle` is the canonical wait
  // for "the page has finished doing whatever it was doing".
  await page.waitForLoadState('networkidle');
  await expect(page).toHaveScreenshot(`${name}.png`, {
    // Be lenient about anti-aliasing + minor font rendering differences
    // across OSes; a real visual regression usually moves pixels by >0.5%.
    maxDiffPixelRatio: 0.005,
    // Hide the cursor blink and any active animations so the snapshot is
    // deterministic across runs.
    animations: 'disabled',
    caret: 'hide',
  });
});
