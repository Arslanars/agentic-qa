import { type Locator, type Page } from '@playwright/test';
import { BasePage } from '../BasePage';

/**
 * The **tablet POS ordering wizard** — an overlay on `/inventory-vendors` reached
 * after enabling tablet view (see InventoryVendorsPage.enableTabletView).
 *
 * Flow: Orders tab → "Continue to Vendors → (N)" → vendor list → "Review All
 * Orders →" (heading "Review order before sending") → "Send N orders" (submits
 * REAL vendor orders — DESTRUCTIVE) → each vendor row flips to "Sent ✓".
 *
 * Live verification (2026-07-16): the literal toast "Sent N orders across N" was
 * NOT observable across 3 sends; the app's genuine confirmation is the per-vendor
 * "Sent ✓" state (asserted in the step layer). Dynamic counts in the button
 * labels ((160), "5 orders") are matched by regex so the POM stays stable as the
 * counts change.
 */
export class TabletOrderPage extends BasePage {
  // Overlay on the inventory-vendors route; kept for BasePage's abstract url.
  readonly url = 'https://moontower.aiimone.com/inventory-vendors';

  readonly ordersTab: Locator;
  readonly continueToVendorsButton: Locator;
  readonly reviewAllOrdersButton: Locator;
  readonly reviewHeading: Locator;
  readonly sendOrdersButton: Locator;
  /** Per-vendor "Sent ✓" badge — the real post-send confirmation. */
  readonly sentBadges: Locator;
  readonly cancelButton: Locator;

  constructor(page: Page) {
    super(page);
    this.ordersTab = page.getByRole('button', { name: 'Orders', exact: true });
    this.continueToVendorsButton = page.getByRole('button', { name: /Continue to Vendors/i });
    this.reviewAllOrdersButton = page.getByRole('button', { name: /Review All Orders/i });
    this.reviewHeading = page.getByRole('heading', { name: /Review order before sending/i });
    this.sendOrdersButton = page.getByRole('button', { name: /Send\s+\d+\s+orders?/i });
    this.sentBadges = page.getByText(/Sent\s*✓/);
    this.cancelButton = page.getByRole('button', { name: 'Cancel', exact: true });
  }

  /** The tablet top-bar "Orders" tab (distinct from the sidebar Orders group). */
  async openOrdersTab(): Promise<void> {
    await this.ordersTab.first().waitFor({ state: 'visible', timeout: 30_000 });
    await this.ordersTab.first().click();
  }

  async continueToVendors(): Promise<void> {
    await this.continueToVendorsButton.first().waitFor({ state: 'visible', timeout: 20_000 });
    await this.continueToVendorsButton.first().click();
  }

  async reviewAllOrders(): Promise<void> {
    await this.reviewAllOrdersButton.first().waitFor({ state: 'visible', timeout: 20_000 });
    await this.reviewAllOrdersButton.first().click();
    await this.reviewHeading.waitFor({ state: 'visible', timeout: 20_000 });
  }

  /** DESTRUCTIVE — submits the real vendor orders. */
  async sendOrders(): Promise<void> {
    await this.sendOrdersButton.first().waitFor({ state: 'visible', timeout: 20_000 });
    await this.sendOrdersButton.first().click();
  }

  /** Wait for the send to finish (a "Sent ✓" badge appears). */
  async waitForSent(): Promise<void> {
    await this.sentBadges.first().waitFor({ state: 'visible', timeout: 40_000 });
  }

  /** "Toggle" a vendor = open its editor by clicking the vendor name. */
  async toggleVendor(name: string): Promise<void> {
    const vendor = this.page.getByText(name, { exact: true }).first();
    await vendor.waitFor({ state: 'visible', timeout: 20_000 });
    await vendor.click();
  }

  async cancel(): Promise<void> {
    await this.cancelButton.first().waitFor({ state: 'visible', timeout: 15_000 });
    await this.cancelButton.first().click();
  }
}
