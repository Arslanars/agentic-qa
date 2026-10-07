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
import { LocationPickerPage } from '../../pages/verify-dashboard/LocationPickerPage';
import { DashboardPage } from '../../pages/verify-dashboard/DashboardPage';
import { VendorsPage } from '../../pages/verify-dashboard-with-tab/VendorsPage';

// Scope these definitions to the @dashboard-tab feature tag so the shared step
// phrases (e.g. `I should see the heading {string}`) don't collide in
// Cucumber's global step pool with the @dashboard (verify-dashboard) feature.
//
// Login, location choice and the dashboard-URL assertion come from
// features/_shared/common.steps.ts, which is why LoginPage and the credential
// constants are no longer needed here.
const { When, Then } = createBdd(undefined, { tags: '@dashboard-tab' });





Then('I should be redirected to the location-picker screen', async ({ page }) => {
  // AC1: a successful login leaves /login and lands on /select-location.
  const picker = new LocationPickerPage(page);
  await picker.expectLoaded();
});

Then('I should see the heading {string}', async ({ page }, name: string) => {
  // AC2: the "Select Your Location" prompt is visible after login.
  await expect(page.getByRole('heading', { name })).toBeVisible({ timeout: 15_000 });
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
    await dashboard.openTab(tab);
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
// Selectors live on VendorsPage; these steps stay a thin DSL over it.
When('I navigate to the Vendors List', async ({ page }) => {
  const vendors = new VendorsPage(page);
  await vendors.openVendorsList();
  await vendors.expectLoaded();
});

When("I open the first vendor's details", async ({ page }) => {
  await new VendorsPage(page).openFirstVendorEditor();
});

When('I edit the vendor name to {string} and save the changes', async ({ page }, name: string) => {
  await new VendorsPage(page).renameVendor(name);
});

Then('the vendor changes should be saved', async ({ page }) => {
  await new VendorsPage(page).expectSaved();
});
