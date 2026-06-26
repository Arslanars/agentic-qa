import { test, expect } from '@playwright/test';
import { SignupPage } from '../../pages/user-signup/SignupPage';

const PASSWORD = process.env.MOONTOWER_SIGNUP_PASSWORD || 'TestPass!2025';
const EMAIL_BASE = process.env.MOONTOWER_SIGNUP_EMAIL || 'arslan.moon@yopmail.com';

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

function uniqueEmail(tag: string): string {
  const [local, domain] = EMAIL_BASE.split('@');
  return `${local}+${tag}${uniqueSuffix()}@${domain}`;
}

test.describe('SignUp / Step 1 validation', () => {
  test('NEG-01 — Restaurant Name empty: Next does not advance', async ({ page }) => {
    const signup = new SignupPage(page);
    await signup.goto();
    await signup.expectStep1Rendered();

    await signup.fullNameInput.fill('Arslan Tester');
    await signup.businessEmailInput.fill(uniqueEmail('rn'));
    await signup.phoneNumberInput.fill('5555550199');
    await signup.nextButton.click();

    await page.waitForTimeout(1500);
    await expect(signup.step1Heading).toBeVisible();
    await expect(signup.step2Heading).toBeHidden();
  });

  test('NEG-03 — Business Email empty: Next does not advance', async ({ page }) => {
    const signup = new SignupPage(page);
    await signup.goto();
    await signup.expectStep1Rendered();

    await signup.restaurantNameInput.fill(`MoonNeg${uniqueSuffix()}`);
    await signup.fullNameInput.fill('Arslan Tester');
    await signup.phoneNumberInput.fill('5555550199');
    await signup.nextButton.click();

    await page.waitForTimeout(1500);
    await expect(signup.step1Heading).toBeVisible();
    await expect(signup.step2Heading).toBeHidden();
  });

  test('NEG-04 — invalid email format (no @): Next does not advance', async ({ page }) => {
    const signup = new SignupPage(page);
    await signup.goto();
    await signup.expectStep1Rendered();

    await signup.restaurantNameInput.fill(`MoonNeg${uniqueSuffix()}`);
    await signup.fullNameInput.fill('Arslan Tester');
    await signup.businessEmailInput.fill('arslan-yopmail.com');
    await signup.phoneNumberInput.fill('5555550199');
    await signup.nextButton.click();

    await page.waitForTimeout(1500);
    await expect(signup.step1Heading).toBeVisible();
    await expect(signup.step2Heading).toBeHidden();
    // input[type=email] should report typeMismatch for "arslan-yopmail.com"
    const isInvalid = await signup.businessEmailInput.evaluate(
      (el) => (el as HTMLInputElement).validity?.typeMismatch === true,
    );
    expect(isInvalid, 'Business Email input should flag typeMismatch for "arslan-yopmail.com"').toBe(true);
  });

  test('NEG-07 — Subdomain auto-derives from Restaurant Name (read-only, lowercased)', async ({ page }) => {
    const signup = new SignupPage(page);
    await signup.goto();
    await signup.expectStep1Rendered();

    await expect(signup.subdomainInput).toHaveAttribute('readonly', '');
    await signup.restaurantNameInput.fill('My Eatery 42');
    const derived = (await signup.readSubdomain()).toLowerCase();
    // Subdomain is kebab-cased (lowercase alphanumeric + hyphens only)
    expect(derived).toMatch(/^[a-z0-9-]+$/);
    expect(derived).toContain('my');
    expect(derived).toContain('eatery');
  });
});

test.describe('SignUp / Step 2 validation', () => {
  // Helper: get to step 2 with valid step-1 data (does NOT submit step 2,
  // so no account is created — these tests are read-only on the server).
  async function reachStep2(signup: SignupPage, suffix: string) {
    await signup.goto();
    await signup.expectStep1Rendered();
    await signup.fillStep1({
      restaurantName: `MoonValidation${suffix}`,
      fullName: 'Arslan Validation',
      businessEmail: uniqueEmail(`val-${suffix}`),
      phoneNumber: '5555550199',
    });
    await signup.submitStep1();
  }

  test('NEG-10 — Create Account is disabled when Terms checkbox is unchecked', async ({ page }) => {
    const signup = new SignupPage(page);
    await reachStep2(signup, uniqueSuffix());

    await signup.passwordInput.fill(PASSWORD);
    await signup.confirmPasswordInput.fill(PASSWORD);
    // Intentionally NOT checking the Terms checkbox.
    await expect(signup.termsCheckbox).not.toBeChecked();
    await expect(signup.createAccountButton).toBeDisabled();
  });

  test('NEG-08 — Create Account does not submit when passwords mismatch', async ({ page }) => {
    const signup = new SignupPage(page);
    await reachStep2(signup, uniqueSuffix());

    await signup.passwordInput.fill(PASSWORD);
    await signup.confirmPasswordInput.fill(`Different${PASSWORD}`);
    await signup.termsCheckbox.check();

    // Click Create Account if enabled. Whether the button is disabled OR the
    // click is a no-op, the URL must remain on /signup.
    const enabled = await signup.createAccountButton.isEnabled();
    if (enabled) await signup.createAccountButton.click();
    await page.waitForTimeout(1500);

    await expect(page).toHaveURL(/\/signup$/, { timeout: 5_000 });
    await expect(signup.step2Heading).toBeVisible();
  });
});
