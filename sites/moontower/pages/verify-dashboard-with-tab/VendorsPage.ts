import { type Locator, type Page, expect } from '@playwright/test';
import { BasePage } from '../../../../pages/BasePage';

/**
 * Vendors list + vendor editor (DashBoard-002).
 *
 * Reached from the dashboard sidebar: the **Vendors** group is collapsed on a
 * freshly-loaded dashboard, and "Vendors List" is a sub-item inside it. It is
 * NOT under Quick Inventory — that route is /quick-inventory and has no such
 * item. Opening it routes to /vendors ("Manage Vendors").
 *
 * Vendors render as cards (the default "Card" view), not a table, so each card
 * carries its own "Edit vendor" icon button which opens the "Edit Vendor
 * Details" drawer.
 *
 * All selector knowledge for this flow lives here rather than in the step file,
 * so a rename in the app is a one-file change.
 */
export class VendorsPage extends BasePage {
  readonly url = 'https://moontower.aiimone.com/vendors';

  /** Collapsible sidebar group. exact:true so it does not also match
   *  "Vendors List" or "Vendor Items". */
  readonly vendorsGroup: Locator;
  readonly vendorsListItem: Locator;
  readonly manageVendorsHeading: Locator;
  readonly editVendorButtons: Locator;
  readonly editorHeading: Locator;
  /** The always-mounted "Add New Vendor" drawer is aria-hidden, so this role
   *  query resolves only to the open editor (verified count = 1). */
  readonly vendorNameField: Locator;
  readonly saveChangesButton: Locator;
  /** Save surfaces an aria-live toast — the stable success signal. */
  readonly savedToast: Locator;

  constructor(page: Page) {
    super(page);
    this.vendorsGroup = page.getByRole('button', { name: 'Vendors', exact: true });
    this.vendorsListItem = page.getByRole('button', { name: /vendors list/i });
    this.manageVendorsHeading = page.getByRole('heading', { name: 'Manage Vendors' });
    this.editVendorButtons = page.getByRole('button', { name: 'Edit vendor' });
    this.editorHeading = page.getByRole('heading', { name: /edit vendor details/i });
    this.vendorNameField = page.getByRole('textbox', { name: 'Enter vendor name', exact: true });
    this.saveChangesButton = page.getByRole('button', { name: /save changes/i });
    this.savedToast = page.getByText(/updated successfully|has been saved/i).first();
  }

  /**
   * Expand the Vendors group if needed, then open the Vendors List.
   * Idempotent — skips the expand when the sub-item is already showing.
   */
  async openVendorsList(): Promise<void> {
    if (!(await this.vendorsListItem.isVisible().catch(() => false))) {
      await this.vendorsGroup.waitFor({ state: 'visible', timeout: 30_000 });
      await this.vendorsGroup.click();
    }
    await this.vendorsListItem.waitFor({ state: 'visible', timeout: 15_000 });
    await this.vendorsListItem.click();
  }

  async expectLoaded(): Promise<void> {
    await expect(this.manageVendorsHeading).toBeVisible({ timeout: 20_000 });
  }

  /** Open the first vendor card's editor drawer. */
  async openFirstVendorEditor(): Promise<void> {
    const first = this.editVendorButtons.first();
    await first.waitFor({ state: 'visible', timeout: 20_000 });
    await first.click();
    await expect(this.editorHeading).toBeVisible({ timeout: 15_000 });
  }

  async renameVendor(name: string): Promise<void> {
    await this.vendorNameField.waitFor({ state: 'visible', timeout: 15_000 });
    await this.vendorNameField.fill(name);
    await this.saveChangesButton.click();
  }

  async expectSaved(): Promise<void> {
    await expect(this.savedToast).toBeVisible({ timeout: 15_000 });
  }
}
