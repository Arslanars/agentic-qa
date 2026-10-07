import { type Locator, type Page, expect } from '@playwright/test';
import { BasePage } from '../../../../pages/BasePage';

export class OcLoginPage extends BasePage {
  readonly url = 'https://testai.v2.ordercircle.com/';

  readonly usernameInput: Locator;
  readonly passwordInput: Locator;
  readonly rememberMeCheckbox: Locator;
  readonly rememberMeLabel: Locator;
  readonly signInButton: Locator;
  readonly userMenu: Locator;
  readonly signOutButton: Locator;

  constructor(page: Page) {
    super(page);
    this.usernameInput = page.getByPlaceholder('Username');
    this.passwordInput = page.getByPlaceholder('Password');
    this.rememberMeCheckbox = page.getByRole('checkbox', { name: 'Remember me' });
    // The native <input> is opacity:0 + pointer-events:none, so it can't be
    // clicked; the wrapping <label> is the only clickable surface. Click it to
    // toggle the checkbox the way a real user does.
    this.rememberMeLabel = page.getByText('Remember me', { exact: true });
    this.signInButton = page.getByRole('button', { name: 'Sign In' });
    // The user menu is a custom dropdown toggle (<div data-toggle="dropdown">
    // styled as a button) with no ARIA role or accessible name, so its stable
    // component class is the only handle. Its hidden mobile twin is .svg-profile-icon.
    this.userMenu = page.locator('.desktop-profile-btn');
    // "Sign Out" is an <a> with no href, so it exposes no link role and can only
    // be matched by its visible text.
    this.signOutButton = page.getByText('Sign Out', { exact: true });
  }

  async open(): Promise<void> {
    await this.goto();
    await this.page.waitForLoadState('domcontentloaded');
    await expect(this.usernameInput).toBeVisible({ timeout: 15_000 });
    await expect(this.signInButton).toBeVisible({ timeout: 15_000 });
  }

  async enterCredentials(username: string, password: string): Promise<void> {
    await this.usernameInput.fill(username);
    await this.passwordInput.fill(password);
  }

  async checkRememberMe(): Promise<void> {
    // Clicking the hidden <input> is a no-op (pointer-events:none), so click the
    // wrapping label instead. Guard on current state so this stays idempotent
    // like check(), then confirm the checkbox actually flipped on.
    if (!(await this.rememberMeCheckbox.isChecked())) {
      await this.rememberMeLabel.click();
    }
    await expect(this.rememberMeCheckbox).toBeChecked();
  }

  async clickSignIn(): Promise<void> {
    await this.signInButton.click();
  }

  async expectLoggedIn(): Promise<void> {
    // Sign In routes client-side to /dashboard with no full navigation; give the
    // SPA a generous budget to route and paint the authenticated topbar.
    await expect(this.page).toHaveURL(/\/dashboard/, { timeout: 15_000 });
    await expect(this.userMenu).toBeVisible({ timeout: 15_000 });
  }

  async openUserMenu(): Promise<void> {
    await this.userMenu.click();
    // Opening the dropdown reveals Sign Out; wait for it so the next step is stable.
    await expect(this.signOutButton).toBeVisible({ timeout: 15_000 });
  }

  async clickSignOut(): Promise<void> {
    await this.signOutButton.click();
  }

  async expectOnLoginPage(): Promise<void> {
    // Logout returns to the root login screen; the form re-rendering is the signal.
    await expect(this.usernameInput).toBeVisible({ timeout: 15_000 });
    await expect(this.signInButton).toBeVisible({ timeout: 15_000 });
  }
}
