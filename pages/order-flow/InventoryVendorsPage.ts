import { type Locator, type Page, expect } from '@playwright/test';
import { BasePage } from '../BasePage';

/**
 * The inventory-vendors dashboard shell (`/inventory-vendors`) as used by the
 * Order-01 flow: the left **sidebar** nav plus the **Tablet Preview** toggle
 * that switches the app into its tablet POS layout.
 *
 * Reuse note (framework Rule 2/9): login + location picking are handled by the
 * already-proven `LoginPage` (pages/login-user) and `LocationPickerPage`
 * (pages/verify-dashboard) — this POM only owns the order-flow-specific dashboard
 * navigation. `DashboardPage` (verify-dashboard) is intentionally NOT extended:
 * it is scoped to the AC4 "Inventory tab" assertion, whereas the order flow needs
 * a broader nav surface (Quick Inventory, the Orders group, tablet enable/exit).
 *
 * Live selectors verified 2026-07-16 (direct Playwright exploration):
 *  - "Tablet Preview" is a pill `<button>` at the sidebar bottom; its active CSS
 *    class is unstable, so tablet-ON is detected by the "Exit tablet" button being
 *    visible (a stable, semantic signal).
 *  - The sidebar "Orders" item is a collapsible group; clicking it reveals
 *    "Draft Order", "Orders List", "Invoice Log".
 */
export class InventoryVendorsPage extends BasePage {
  readonly url = 'https://moontower.aiimone.com/inventory-vendors';

  readonly quickInventoryNav: Locator;
  readonly inventoryNav: Locator;
  readonly ordersNav: Locator;
  readonly ordersListNav: Locator;
  /** The sidebar-bottom "Tablet Preview" toggle (matched by text, not a11y name). */
  readonly tabletToggle: Locator;
  readonly exitTabletButton: Locator;
  /** Optional "Not now" button on the tablet draft-restore prompt. */
  readonly dismissDraftButton: Locator;

  constructor(page: Page) {
    super(page);
    this.quickInventoryNav = page.getByRole('button', { name: 'Quick Inventory' });
    // exact:true so "Inventory" doesn't also match "Quick Inventory" / "Inventory Items".
    this.inventoryNav = page.getByRole('button', { name: 'Inventory', exact: true });
    this.ordersNav = page.getByRole('button', { name: 'Orders', exact: true });
    this.ordersListNav = page.getByRole('button', { name: 'Orders List' });
    this.tabletToggle = page.locator('button').filter({ hasText: 'Tablet Preview' });
    this.exitTabletButton = page.getByRole('button', { name: 'Exit tablet' });
    this.dismissDraftButton = page.getByRole('button', { name: 'Not now' });
  }

  async expectLoaded(): Promise<void> {
    // Client-side nav from /select-location + async render — give it a generous
    // budget (mirrors DashboardPage).
    await this.page.waitForLoadState('domcontentloaded');
    await expect(this.page).toHaveURL(/\/inventory-vendors/, { timeout: 20_000 });
  }

  async isTabletActive(): Promise<boolean> {
    return this.exitTabletButton.isVisible({ timeout: 1_500 }).catch(() => false);
  }

  async openQuickInventory(): Promise<void> {
    await this.quickInventoryNav.waitFor({ state: 'visible', timeout: 30_000 });
    await this.quickInventoryNav.click();
    await this.page.waitForURL(/\/quick-inventory/, { timeout: 20_000 });
  }

  async openInventory(): Promise<void> {
    await this.inventoryNav.waitFor({ state: 'visible', timeout: 30_000 });
    await this.inventoryNav.click();
    await this.page.waitForURL(/\/inventory-vendors/, { timeout: 20_000 });
  }

  /** Enable the tablet POS layout. Idempotent — no-op if already in tablet mode. */
  async enableTabletView(): Promise<void> {
    if (await this.isTabletActive()) return;
    await this.tabletToggle.first().waitFor({ state: 'visible', timeout: 30_000 });
    await this.tabletToggle.first().click();
    await this.exitTabletButton.waitFor({ state: 'visible', timeout: 20_000 });
    // A "Load draft / Not now" prompt sometimes appears on entering tablet mode;
    // dismiss it (start fresh) so the order counts are deterministic. Optional.
    if (await this.dismissDraftButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await this.dismissDraftButton.click();
    }
  }

  async exitTabletView(): Promise<void> {
    await this.exitTabletButton.waitFor({ state: 'visible', timeout: 20_000 });
    await this.exitTabletButton.click();
    // Back to the normal dashboard — the "Tablet Preview" toggle reappears.
    await this.tabletToggle.first().waitFor({ state: 'visible', timeout: 20_000 });
  }

  /** Expand the sidebar "Orders" group (reveals Draft Order / Orders List / Invoice Log). */
  async openOrdersMenu(): Promise<void> {
    await this.ordersNav.waitFor({ state: 'visible', timeout: 20_000 });
    await this.ordersNav.click();
    await this.ordersListNav.waitFor({ state: 'visible', timeout: 15_000 });
  }

  /** Open the Orders List page (`/order-history`), expanding the group first if needed. */
  async openOrdersList(): Promise<void> {
    if (!(await this.ordersListNav.isVisible({ timeout: 1_500 }).catch(() => false))) {
      await this.openOrdersMenu();
    }
    await this.ordersListNav.click();
    await this.page.waitForURL(/\/order-history/, { timeout: 20_000 });
  }
}
