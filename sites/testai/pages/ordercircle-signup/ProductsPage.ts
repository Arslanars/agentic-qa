import { type Locator, type Page, expect } from '@playwright/test';
import { BasePage } from '../../../../pages/BasePage';

export class ProductsPage extends BasePage {
  readonly url = 'https://testai.v2.ordercircle.com/products';

  readonly productsNavLink: Locator;
  readonly productNameInput: Locator;
  readonly skuInput: Locator;
  readonly inventoryTrackingToggle: Locator;
  readonly inventoryLevelInput: Locator;
  readonly productFormHeading: Locator;

  constructor(page: Page) {
    super(page);
    this.productsNavLink = page.getByRole('link', { name: 'Products' });
    this.productNameInput = page.getByLabel(/product name/i);
    this.skuInput = page.getByLabel(/sku/i);
    this.inventoryTrackingToggle = page.getByRole('checkbox', { name: /inventory tracking/i });
    this.inventoryLevelInput = page.getByLabel(/inventory level/i);
    this.productFormHeading = page.getByRole('heading', { name: /add new product/i });
  }

  async open(): Promise<void> {
    await this.productsNavLink.click();
  }

  async clickButton(name: string): Promise<void> {
    await this.page.getByRole('button', { name }).click();
  }

  async enterProductName(name: string): Promise<void> {
    await this.productNameInput.fill(name);
  }

  async enterProductSku(sku: string): Promise<void> {
    await this.skuInput.fill(sku);
  }

  async enableInventoryTracking(): Promise<void> {
    await this.inventoryTrackingToggle.check();
  }

  async setInventoryLevel(level: string): Promise<void> {
    await this.inventoryLevelInput.fill(level);
  }

  async expectFormDisplayed(): Promise<void> {
    // Give first paint a generous budget — this live app renders slowly.
    await this.page.waitForLoadState('domcontentloaded');
    await expect(this.productFormHeading).toBeVisible({ timeout: 15000 });
  }
}
