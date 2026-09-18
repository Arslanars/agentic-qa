import { type Locator, type Page, expect } from '@playwright/test';
import { BasePage } from '../../../../pages/BasePage';

/** Sign-in screen of the public Sauce Labs demo shop. */
export class SauceLoginPage extends BasePage {
  readonly url = 'https://www.saucedemo.com/';

  readonly username: Locator;
  readonly password: Locator;
  readonly signIn: Locator;

  constructor(page: Page) {
    super(page);
    this.username = page.getByRole('textbox', { name: 'Username' });
    this.password = page.getByRole('textbox', { name: 'Password' });
    this.signIn = page.getByRole('button', { name: 'Login' });
  }

  async expectLoaded(): Promise<void> {
    await expect(this.signIn).toBeVisible({ timeout: 15_000 });
  }

  async login(user: string, pass: string): Promise<void> {
    await this.username.fill(user);
    await this.password.fill(pass);
    await this.signIn.click();
  }
}
