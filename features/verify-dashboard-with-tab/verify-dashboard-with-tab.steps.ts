// Step definitions for features/verify-dashboard-with-tab/verify-dashboard-with-tab.feature.
//
// DashBoard-002 = DashBoard-001 + AC4 (open the Inventory tab). Reuse over
// recreate (framework Rule 2/3/9): every POM here already exists —
//   - LoginPage          (pages/login-user/LoginPage.ts)            — login
//   - LocationPickerPage (pages/verify-dashboard/LocationPickerPage.ts) — AC2/AC3
//   - DashboardPage      (pages/verify-dashboard/DashboardPage.ts)   — AC3 URL + AC4 tab
// No new page object is created; DashboardPage was extended additively with the
// Inventory-tab locators/action, so DashBoard-001 keeps passing.

import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { LoginPage } from '../../pages/login-user/LoginPage';
import { LocationPickerPage } from '../../pages/verify-dashboard/LocationPickerPage';
import { DashboardPage } from '../../pages/verify-dashboard/DashboardPage';

// Scope these definitions to the @dashboard-tab feature tag so the shared step
// phrases (e.g. `I should see the heading {string}`) don't collide in
// Cucumber's global step pool with the @dashboard (verify-dashboard) feature.
const { Given, When, Then } = createBdd(undefined, { tags: '@dashboard-tab' });

// Credentials read from the environment with safe fallbacks (the established
// Moontower test account) — never hard-coded in the .feature.
const EMAIL = process.env.MOONTOWER_LOGIN_EMAIL || 'developers@moontower.com';
const PASSWORD = process.env.MOONTOWER_LOGIN_PASSWORD || '12345678';

Given('I am on the Moontower login page', async ({ page }) => {
  const login = new LoginPage(page);
  await login.goto();
  await login.expectLoaded();
});

When('I log in with the provided Moontower credentials', async ({ page }) => {
  const login = new LoginPage(page);
  await login.login(EMAIL, PASSWORD);
});

Then('I should be redirected to the location-picker screen', async ({ page }) => {
  // AC1: a successful login leaves /login and lands on /select-location.
  const picker = new LocationPickerPage(page);
  await picker.expectLoaded();
});

Then('I should see the heading {string}', async ({ page }, name: string) => {
  // AC2: the "Select Your Location" prompt is visible after login.
  await expect(page.getByRole('heading', { name })).toBeVisible({ timeout: 15_000 });
});

When('I choose the {string} option', async ({ page }, label: string) => {
  const picker = new LocationPickerPage(page);
  await picker.expectLoaded();
  if (/main location/i.test(label)) {
    await picker.selectMainLocation();
  } else {
    // Fall back to a role-based match so the step works if more locations appear.
    await page.getByRole('button', { name: label }).click();
  }
});

Then('the dashboard URL should be {string}', async ({ page }, expectedUrl: string) => {
  // AC3: clicking "Main Location" must route to the inventory-vendors dashboard.
  const dashboard = new DashboardPage(page);
  await dashboard.expectLoaded();
  await expect(page, 'AC3: dashboard URL must equal the inventory-vendors route').toHaveURL(expectedUrl, {
    timeout: 20_000,
  });
});

When('I open the {string} tab', async ({ page }, tab: string) => {
  // AC4: open the requested sidebar tab. Only "Inventory" is in scope for this
  // story; route it through the DashboardPage POM. Any other label falls back
  // to a role-based click so the step stays reusable.
  const dashboard = new DashboardPage(page);
  await dashboard.expectLoaded();
  if (/^inventory$/i.test(tab)) {
    await dashboard.openInventoryTab();
  } else {
    const btn = page.getByRole('button', { name: tab, exact: true });
    await btn.waitFor({ state: 'visible', timeout: 30_000 });
    await btn.click();
  }
});

Then('the {string} tab should be the active dashboard tab', async ({ page }, tab: string) => {
  // AC4: after clicking the Inventory tab the Inventory view must be active.
  // The app exposes no aria-selected/aria-current — the only "selected" signal
  // is the active CSS class (bg-[#DC2626], red) — so prove selection three
  // ways: stayed on the dashboard route, the Inventory heading is visible, and
  // the tab carries the active styling.
  expect(/^inventory$/i.test(tab), 'AC4 only covers the Inventory tab').toBeTruthy();
  const dashboard = new DashboardPage(page);
  await expect(page, 'AC4: still on the inventory-vendors dashboard after the tab click').toHaveURL(
    dashboard.url,
    { timeout: 20_000 },
  );
  await expect(dashboard.inventoryHeading, 'AC4: the Inventory view heading is shown').toBeVisible({
    timeout: 20_000,
  });
  await expect(dashboard.inventoryTab, 'AC4: the Inventory tab is the active (highlighted) tab').toHaveClass(
    /bg-\[#DC2626\]/,
    { timeout: 10_000 },
  );
});
