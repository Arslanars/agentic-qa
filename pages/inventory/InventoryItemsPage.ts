import { type Locator, type Page, expect } from '@playwright/test';
import { BasePage } from '../BasePage';

/**
 * The **Inventory Items** catalog page (`/inventory`), reached from the sidebar
 * "Inventory Items" entry.
 *
 * Interaction model (verified 2026-09-04 via direct Playwright exploration):
 *  - Each catalog row has an **"Expand row"** chevron button that expands the row
 *    *in place* to reveal its **Vendor Links** table. Clicking the product *name*
 *    instead is a link that navigates away to `/inventory/<id>/mappings` — the
 *    scaffolded step used to do this, which is why the pack-size step then hung.
 *  - Inside the expanded row, each vendor link has a **"Set pack size for …"**
 *    button that opens a right-hand **drawer** (role=dialog) with `Cases` /
 *    `Units per case` spinbuttons, a unit selector, and a `Save` button.
 *  - The drawer **disables Save when the new pack size equals the current one**
 *    (a no-op emits no confirmation). `setPackSize` therefore nudges through a
 *    scratch value when the item is already at the target so the save is always a
 *    real change that emits the "Pack size set to X/Y LB" toast.
 */
export class InventoryItemsPage extends BasePage {
  readonly url = 'https://moontower.aiimone.com/inventory';

  readonly searchBox: Locator;
  readonly heading: Locator;

  constructor(page: Page) {
    super(page);
    this.searchBox = page.getByPlaceholder(/search by name or code/i);
    this.heading = page.getByRole('heading', { name: 'Inventory Items' });
  }

  async expectLoaded(): Promise<void> {
    await this.page.waitForLoadState('domcontentloaded');
    await expect(this.page).toHaveURL(/\/inventory(\b|$)/, { timeout: 20_000 });
    await expect(this.searchBox).toBeVisible({ timeout: 20_000 });
  }

  /** Narrow the catalog to a single product so the row is present regardless of
   *  the default sort / pagination (the catalog has hundreds of entries). */
  async searchFor(product: string): Promise<void> {
    await this.searchBox.waitFor({ state: 'visible', timeout: 20_000 });
    await this.searchBox.fill(product, { timeout: 10_000 });
    // Client-side filter is debounced; give it a beat to re-render the table.
    await this.page.waitForTimeout(800);
  }

  private rowFor(product: string): Locator {
    return this.page.getByRole('row').filter({ hasText: product }).first();
  }

  /** The first vendor's "Set pack size for …" button in the (single) expanded row. */
  private get packSizeButton(): Locator {
    return this.page.getByRole('button', { name: /set pack size for/i }).first();
  }

  /** Expand the catalog row for a product to reveal its Vendor Links.
   *  Idempotent — no-op if the row's pack-size editor button is already showing. */
  async expandRow(product: string): Promise<void> {
    await this.searchFor(product);
    const row = this.rowFor(product);
    await row.waitFor({ state: 'visible', timeout: 20_000 });
    if (!(await this.packSizeButton.isVisible({ timeout: 1_500 }).catch(() => false))) {
      await row.getByRole('button', { name: 'Expand row' }).click({ timeout: 15_000 });
      await this.packSizeButton.waitFor({ state: 'visible', timeout: 15_000 });
    }
  }

  private get dialog(): Locator {
    return this.page.getByRole('dialog');
  }

  private get saveButton(): Locator {
    return this.dialog.getByRole('button', { name: 'Save', exact: true });
  }

  private async openEditor(): Promise<void> {
    await this.packSizeButton.waitFor({ state: 'visible', timeout: 15_000 });
    await this.packSizeButton.click({ timeout: 15_000 });
    await this.dialog.waitFor({ state: 'visible', timeout: 10_000 });
  }

  private async fillEditor(cases: number, unitsPerCase: number): Promise<void> {
    await this.dialog.getByRole('spinbutton', { name: 'Cases' }).fill(String(cases), { timeout: 10_000 });
    await this.dialog.getByRole('spinbutton', { name: 'Units per case' }).fill(String(unitsPerCase), { timeout: 10_000 });
  }

  /** Poll for Save becoming enabled (the app enables it only once the new pack
   *  size differs from the current one). Returns false if it never enables. */
  private async saveEnabled(tries = 10, gapMs = 200): Promise<boolean> {
    for (let i = 0; i < tries; i++) {
      if (await this.saveButton.isEnabled().catch(() => false)) return true;
      await this.page.waitForTimeout(gapMs);
    }
    return false;
  }

  private async commit(): Promise<void> {
    if (!(await this.saveEnabled(15))) {
      throw new Error('Pack-size "Save" never became enabled (value unchanged?).');
    }
    await this.saveButton.click({ timeout: 10_000 });
    await this.dialog.waitFor({ state: 'hidden', timeout: 10_000 });
  }

  private async closeEditor(): Promise<void> {
    await this.dialog.getByRole('button', { name: /cancel|close drawer/i }).first().click({ timeout: 5_000 }).catch(() => {});
    await this.dialog.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  }

  /** Wait for the "Pack size set to <cases>/<units> LB" confirmation to appear —
   *  proof the write reached the server before we reopen for the next save. */
  private async waitForToast(cases: number, unitsPerCase: number): Promise<void> {
    await this.page
      .getByText(`Pack size set to ${cases}/${unitsPerCase} LB`, { exact: false })
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 })
      .catch(() => {});
  }

  /**
   * Set the pack size on the currently-expanded row's first vendor and save it,
   * emitting the "Pack size set to <cases>/<unitsPerCase> LB" confirmation toast.
   * Requires the row to have been expanded first (see {@link expandRow}).
   *
   * The drawer disables Save on a no-op, so the saved value must differ from the
   * current one for the confirmation to fire. We try the target directly; if the
   * item is already at the target we persist a scratch value first (waiting for
   * its confirmation so the new value settles), then re-save the target as a
   * genuine change. Bounded retries absorb the brief lag before a saved value
   * becomes the drawer's fresh baseline.
   */
  async setPackSize(cases: number, unitsPerCase: number): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      await this.openEditor();
      await this.fillEditor(cases, unitsPerCase);
      if (await this.saveEnabled(10)) {
        await this.commit();
        return;
      }
      // Already at target → persist a distinct scratch value, then loop to re-save
      // the target against the refreshed baseline.
      const scratchUnits = unitsPerCase + 1 + attempt;
      await this.fillEditor(cases, scratchUnits);
      if (await this.saveEnabled(10)) {
        await this.commit();
        await this.waitForToast(cases, scratchUnits);
      } else {
        await this.closeEditor();
      }
    }
    throw new Error('Could not save a changed pack size to emit the confirmation.');
  }
}
