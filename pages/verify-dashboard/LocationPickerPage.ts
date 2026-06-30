import { type Locator, type Page, expect } from '@playwright/test';
import { BasePage } from '../BasePage';

/**
 * The post-login "Select Your Location" screen (`/select-location`).
 *
 * Reached after a successful sign-in (see pages/login-user/LoginPage.ts —
 * reused for the login step). For the provided account this screen exposes a
 * single location button, "Main Location", which routes to the
 * inventory-vendors dashboard.
 */
export class LocationPickerPage extends BasePage {
  readonly url = 'https://moontower.aiimone.com/select-location';

  readonly heading: Locator;
  readonly subtitle: Locator;
  readonly mainLocationButton: Locator;

  constructor(page: Page) {
    super(page);
    this.heading = page.getByRole('heading', { name: 'Select Your Location' });
    this.subtitle = page.getByText(/Choose which location you want to manage/i);
    this.mainLocationButton = page.getByRole('button', { name: 'Main Location' });
  }

  async expectLoaded(): Promise<void> {
    // SPA route + async render — wait for DOM then give the heading a generous
    // budget so post-login hydration is absorbed up-front (mirrors LoginPage).
    await this.page.waitForLoadState('domcontentloaded');
    await expect(this.page).toHaveURL(/\/select-location$/, { timeout: 15_000 });
    await expect(this.heading).toBeVisible({ timeout: 15_000 });
  }

  async selectMainLocation(): Promise<void> {
    await this.mainLocationButton.click();
  }
}
