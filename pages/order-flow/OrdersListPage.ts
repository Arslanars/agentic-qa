import { type Locator, type Page, expect } from '@playwright/test';
import { BasePage } from '../BasePage';

/**
 * The Orders List / order-history screen (`/order-history`) reached from the
 * sidebar Orders group after exiting tablet view.
 *
 * The list is a table (ORDER # / VENDOR / STATUS / ITEMS / DATE / TOTAL / View),
 * newest first, each row with a "View" button that opens the order detail
 * (`/order-history/<id>`). "View order number N" = the Nth "View" button.
 *
 * NOTE (Order-01 discrepancy #2, verified 2026-07-16): a freshly-sent batch's
 * row order is non-deterministic and order #2 was the US FOODS order (no Sprite)
 * in both observed runs — "Sprite" is in the SYSCO order. `getDetailHeading()`
 * lets the step layer report which vendor order #2 actually is when the AC's
 * product assertion fails.
 */
export class OrdersListPage extends BasePage {
  readonly url = 'https://moontower.aiimone.com/order-history';

  readonly heading: Locator;
  readonly viewButtons: Locator;

  constructor(page: Page) {
    super(page);
    this.heading = page.getByRole('heading', { name: 'Orders List' });
    this.viewButtons = page.getByRole('button', { name: /^View$/ });
  }

  async expectLoaded(): Promise<void> {
    await expect(this.page).toHaveURL(/\/order-history/, { timeout: 20_000 });
    await expect(this.heading).toBeVisible({ timeout: 20_000 });
  }

  /** Open the Nth order (1-based) via its row "View" button. */
  async openOrder(n: number): Promise<void> {
    await this.expectLoaded();
    const btn = this.viewButtons.nth(n - 1);
    await btn.waitFor({ state: 'visible', timeout: 20_000 });
    await btn.click();
    // Detail route is /order-history/<uuid>.
    await this.page.waitForURL(/\/order-history\/[^/]+/, { timeout: 20_000 });
    await this.page.waitForLoadState('domcontentloaded');
  }

  /**
   * The order-detail header (e.g. "US FOODS — 07/16/2026"), for failure context.
   * The detail page carries a persistent "Orders List" heading too, so match the
   * vendor/date heading pattern specifically rather than the first heading.
   */
  async getDetailHeading(): Promise<string> {
    const h = this.page.getByRole('heading', { name: /—\s*\d{1,2}\/\d{1,2}\/\d{4}/ }).first();
    return (await h.textContent().catch(() => ''))?.trim() || '';
  }

  /** Locator for a product line in the order detail. */
  productLine(text: string): Locator {
    return this.page.getByText(new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }
}
