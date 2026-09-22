import { type Locator, type Page, expect } from '@playwright/test';
import { BasePage } from '../../../../pages/BasePage';

/**
 * OrderCircle login page (the app root, https://testai.v2.ordercircle.com/).
 *
 * Owns the login form, the "Remember me" toggle, the intermittent first-visit
 * overlay, and the login-page visual baseline (sign-out returns here, which is
 * what AC1-01 snapshots).
 */
export class LoginPage extends BasePage {
  readonly url = 'https://testai.v2.ordercircle.com/';

  readonly usernameInput: Locator;
  readonly passwordInput: Locator;
  readonly signInButton: Locator;
  readonly rememberMeCheckbox: Locator;
  readonly rememberMeLabel: Locator;
  readonly overlayCloseButton: Locator;

  constructor(page: Page) {
    super(page);
    this.usernameInput = page.getByRole('textbox', { name: 'Username' });
    this.passwordInput = page.getByRole('textbox', { name: 'Password' });
    this.signInButton = page.getByRole('button', { name: 'Sign In' });
    this.rememberMeCheckbox = page.getByRole('checkbox', { name: 'Remember me' });
    // The native checkbox is covered by a styled <span> that swallows pointer
    // events (a plain .check() times out), so the visible label is what we
    // actually click to toggle it.
    this.rememberMeLabel = page.getByText('Remember me', { exact: true });
    // Dismiss control for the occasional first-visit announcement/promo overlay
    // (see closeInitialOverlay — it is intermittent and usually absent).
    this.overlayCloseButton = page.getByRole('button', {
      name: /close|got it|skip|no thanks|dismiss|maybe later|ok/i,
    });
  }

  /**
   * Open the app and wait for the sign-in form to be interactive.
   *
   * Nothing else in this scenario navigates, so without this the run stays on
   * about:blank and every later step times out on an element that was never
   * loaded. Waiting for the username field rather than a load event because the
   * form is client-rendered.
   */
  async open(): Promise<void> {
    await this.page.goto(this.url);
    await this.usernameInput.waitFor({ state: 'visible', timeout: 30_000 });
  }

  /**
   * Dismiss the first-visit overlay if one is showing. It is not always present
   * (never in a fresh automated session across an 18s probe), so this is a
   * no-op when there is nothing to close: it clears a precondition, it is not an
   * acceptance criterion, and must not fail the run waiting on an overlay that
   * will not appear.
   */
  async closeInitialOverlay(): Promise<void> {
    const close = this.overlayCloseButton.first();
    try {
      await close.waitFor({ state: 'visible', timeout: 3000 });
      await close.click();
    } catch {
      // No overlay this session — nothing to close.
    }
  }

  /**
   * Fill credentials, ensure "Remember me" is checked, then sign in. Login
   * routes client-side to /dashboard with no navigation event on the POST, so
   * wait for the dashboard URL before the scenario continues.
   */
  async loginWithRememberMe(username: string, password: string): Promise<void> {
    await this.usernameInput.fill(username);
    await this.passwordInput.fill(password);
    if (!(await this.rememberMeCheckbox.isChecked())) {
      await this.rememberMeLabel.click();
    }
    await this.signInButton.click();
    await this.page.waitForURL('**/dashboard', { timeout: 20_000 });
  }

  /**
   * Assert the login page matches its committed visual baseline. Sign-out
   * returns here, so wait for the form to re-render and the network to settle
   * first, otherwise the snapshot flakes on in-flight requests / animations.
   */
  async expectVisualBaseline(): Promise<void> {
    await expect(this.usernameInput).toBeVisible({ timeout: 15_000 });
    await this.page.waitForLoadState('networkidle');
    await expect(this.page).toHaveScreenshot('oc-login-page.png', {
      maxDiffPixelRatio: 0.005,
      animations: 'disabled',
      caret: 'hide',
    });
  }
}
