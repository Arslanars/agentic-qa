import { type Page, expect } from '@playwright/test';

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
