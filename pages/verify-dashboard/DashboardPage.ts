import { type Locator, type Page, expect } from '@playwright/test';
import { BasePage } from '../BasePage';

/**
 * The inventory-vendors dashboard (`/inventory-vendors`) — the screen the app
 * routes to after a location is chosen on the location picker.
 *
 * AC3 (DashBoard-001) scopes verification to the URL ("verify the URL … That's
 * it"), and the dashboard body renders asynchronously after the SPA navigation,
 * so the URL is the stable success signal. This POM is the single source of
 * truth for that URL.
 *
 * DashBoard-002 ("Verify Dashboard with tab", AC4) extends this same page —
 * rather than create a second DashboardPage — with the left sidebar's
 * **Inventory** tab. The dashboard exposes no `role="tab"`/`aria-selected`; the
 * nav items are styled `<button>`s and the *active* tab is conveyed only by a
 * CSS class (`bg-[#DC2626]` red). `inventoryTab` / `inventoryHeading` are the
 * single source of truth for those AC4 locators.
 */
export class DashboardPage extends BasePage {
  readonly url = 'https://moontower.aiimone.com/inventory-vendors';

  /** Left-sidebar "Inventory" nav tab (a styled <button>, not a role=tab). */
  readonly inventoryTab: Locator;
  /** The Inventory view's section heading — visible when the tab is active. */
  readonly inventoryHeading: Locator;

  constructor(page: Page) {
    super(page);
    // exact:true so "Inventory" does not also match "Quick Inventory" /
    // "Inventory Items" in the same sidebar.
    this.inventoryTab = page.getByRole('button', { name: 'Inventory', exact: true });
    this.inventoryHeading = page.getByRole('heading', { name: 'Inventory', exact: true });
  }

  async expectLoaded(): Promise<void> {
    // Client-side navigation from /select-location takes ~1–2 s; give it a
    // generous budget rather than relying on the default 5 s expect timeout.
    await expect(this.page).toHaveURL(this.url, { timeout: 20_000 });
  }

  /**
   * AC4: click the Inventory sidebar tab. The dashboard renders "Loading…" for
   * several seconds before the sidebar appears, so wait for the tab to be
   * visible (not an assertion) before clicking. Assertions live in the spec.
   */
  async openInventoryTab(): Promise<void> {
    await this.inventoryTab.waitFor({ state: 'visible', timeout: 30_000 });
    await this.inventoryTab.click();
  }
}
