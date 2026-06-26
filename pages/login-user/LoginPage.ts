import { type Locator, type Page, expect } from '@playwright/test';
import { BasePage } from '../BasePage';

export class LoginPage extends BasePage {
  readonly url = 'https://moontower.aiimone.com/Login';

  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly signInButton: Locator;
  readonly showPasswordButton: Locator;
  readonly forgotPasswordLink: Locator;
  readonly signUpLink: Locator;
  readonly backLink: Locator;

  constructor(page: Page) {
    super(page);
    this.emailInput = page.getByRole('textbox', { name: 'Email' });
    this.passwordInput = page.getByRole('textbox', { name: 'Password' });
    this.signInButton = page.getByRole('button', { name: 'Sign In' });
    // The button renames to "Hide password" after the first click, so match either.
    this.showPasswordButton = page.getByRole('button', { name: /show password|hide password/i });
    this.forgotPasswordLink = page.getByRole('link', { name: 'Forgot password?' });
    this.signUpLink = page.getByRole('link', { name: 'Sign up' });
    this.backLink = page.getByRole('link', { name: '← Back' });
  }

  async login(email: string, password: string): Promise<void> {
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.signInButton.click();
  }

  async expectLoaded(): Promise<void> {
    await expect(this.emailInput).toBeVisible();
    await expect(this.signInButton).toBeVisible();
  }
}
