import { type Page, expect } from '@playwright/test';

/**
 * Abstract base for every Page Object Model class.
 *
 * Subclasses declare `readonly url` and own their `Locator` properties
 * (initialized in the constructor). Tests interact ONLY through these
 * page objects — never `page.locator(...)` directly.
 */
export abstract class BasePage {
  abstract readonly url: string;

  constructor(protected readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto(this.url);
  }

  async expectLoaded(): Promise<void> {
    await expect(this.page).toHaveURL(this.url);
  }

  async screenshot(name: string): Promise<void> {
    await this.page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });
  }

  async title(): Promise<string> {
    return this.page.title();
  }
}
