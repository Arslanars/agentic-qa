import { type Locator, type Page } from '@playwright/test';
import { BasePage } from '../../../../pages/BasePage';

/**
 * The authenticated OrderCircle shell (post-login, `/dashboard`). Owns the
 * top-right profile menu used to pick the signed-in user and to sign out. The
 * "Hi, <name>" greeting and the "Sign Out" item are plain text nodes (no
 * button/link role), so they are located by text.
 */
export class DashboardPage extends BasePage {
  readonly url = 'https://testai.v2.ordercircle.com/dashboard';

  /** "Hi, <name>" greeting in the header — clicking it opens the profile menu. */
  readonly profileMenuTrigger: Locator;
  readonly signOutButton: Locator;

  constructor(page: Page) {
    super(page);
    this.profileMenuTrigger = page.getByText(/^Hi,/).first();
    this.signOutButton = page.getByText('Sign Out', { exact: true }).first();
  }

  /**
   * Open the profile menu and select the user whose name matches. The menu must
   * be opened first — the user link is not rendered until then.
   */
  async selectUser(name: string): Promise<void> {
    await this.profileMenuTrigger.click();
    const userLink = this.page.getByRole('link', { name: new RegExp(name, 'i') }).first();
    await userLink.waitFor({ state: 'visible', timeout: 15_000 });
    await userLink.click();
  }

  /**
   * Sign out via the profile menu. Selecting a user navigates to their profile
   * and closes the dropdown, so reopen it before clicking Sign Out.
   */
  async signOut(): Promise<void> {
    await this.profileMenuTrigger.click();
    await this.signOutButton.waitFor({ state: 'visible', timeout: 15_000 });
    await this.signOutButton.click();
  }
}
