import { type Locator, type Page } from '@playwright/test';
import { BasePage } from '../../../../pages/BasePage';

export class LoginPage extends BasePage {
  readonly url = 'https://testai.v2.ordercircle.com/';

  readonly usernameInput: Locator;
  readonly passwordInput: Locator;
  readonly signInButton: Locator;

  constructor(page: Page) {
    super(page);
    this.usernameInput = page.getByLabel(/username|email/i);
    this.passwordInput = page.getByLabel(/password/i);
    this.signInButton = page.getByRole('button', { name: /sign in|log ?in/i });
  }

  async login(username: string, password: string): Promise<void> {
    await this.goto();
    // Live app cold-start can be slow to hydrate; settle the DOM before typing.
    await this.page.waitForLoadState('domcontentloaded');
    await this.usernameInput.fill(username);
    await this.passwordInput.fill(password);
    await this.signInButton.click();
  }
}
