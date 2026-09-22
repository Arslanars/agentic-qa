import { type Locator, type Page, expect } from '@playwright/test';
import { BasePage } from '../../../../pages/BasePage';

/** Product list shown after a successful sign-in. */
export class InventoryPage extends BasePage {
  readonly url = 'https://www.saucedemo.com/inventory.html';

  /** Named productsHeading, not `title`: BasePage already defines a title()
   *  method, and a Locator property of the same name does not satisfy it. */
  readonly productsHeading: Locator;

  constructor(page: Page) {
    super(page);
    this.productsHeading = page.getByText('Products', { exact: true });
  }

  async expectLoaded(): Promise<void> {
    await expect(this.page).toHaveURL(this.url, { timeout: 20_000 });
    await expect(this.productsHeading).toBeVisible({ timeout: 15_000 });
  }
}
