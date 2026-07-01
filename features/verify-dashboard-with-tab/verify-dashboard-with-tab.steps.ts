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
  // is the active CSS class (bg-[#A4D0FA], blue) — so prove selection three
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
    /bg-\[#A4D0FA\]/,
    { timeout: 10_000 },
  );
});

// ---- Vendors-list edit flow (verified live against the app 2026-06-30) ----
When('I navigate to the Vendors List', async ({ page }) => {
  // "Vendors List" is a sub-item of the collapsible **Vendors** sidebar group
  // (NOT under Quick Inventory — that route is /quick-inventory and has no such
  // item). On the freshly-loaded dashboard the group is collapsed, so expand
  // "Vendors" first, then open its "Vendors List" sub-item, which routes to
  // /vendors ("Manage Vendors"). Idempotent: skip the expand if it's already open.
  const vendorsList = page.getByRole('button', { name: /vendors list/i });
  if (!(await vendorsList.isVisible().catch(() => false))) {
    // exact:true so "Vendors" doesn't also match "Vendors List" / "Vendor Items".
    const vendorsGroup = page.getByRole('button', { name: 'Vendors', exact: true });
    await vendorsGroup.waitFor({ state: 'visible', timeout: 30_000 });
    await vendorsGroup.click();
  }
  await vendorsList.waitFor({ state: 'visible', timeout: 15_000 });
  await vendorsList.click();
  await expect(page.getByRole('heading', { name: 'Manage Vendors' })).toBeVisible({ timeout: 20_000 });
});

When("I open the first vendor's details", async ({ page }) => {
  // The Vendors List renders vendors as cards (default "Card" view), not a
  // table. Each card carries an "Edit vendor" icon button that opens the
  // editable "Edit Vendor Details" drawer; open the first vendor's editor.
  const editFirstVendor = page.getByRole('button', { name: 'Edit vendor' }).first();
  await editFirstVendor.waitFor({ state: 'visible', timeout: 20_000 });
  await editFirstVendor.click();
  await expect(page.getByRole('heading', { name: /edit vendor details/i })).toBeVisible({ timeout: 15_000 });
});

When('I edit the vendor name to {string} and save the changes', async ({ page }, name: string) => {
  // The editor's name field has the accessible name "Enter vendor name". The
  // always-mounted "Add New Vendor" drawer is aria-hidden, so this role query
  // resolves only to the open editor (verified count=1). Save = "Save Changes".
  const nameField = page.getByRole('textbox', { name: 'Enter vendor name', exact: true });
  await nameField.waitFor({ state: 'visible', timeout: 15_000 });
  await nameField.fill(name);
  await page.getByRole('button', { name: /save changes/i }).click();
});

Then('the vendor changes should be saved', async ({ page }) => {
  // A successful save surfaces the aria-live toast "Vendor details updated
  // successfully!" and closes the editor — the toast is the stable success signal.
  await expect(page.getByText(/updated successfully|has been saved/i).first()).toBeVisible({
    timeout: 15_000,
  });
});
