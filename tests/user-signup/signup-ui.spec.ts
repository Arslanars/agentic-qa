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

test.describe('SignUp / UI behavior', () => {
  test('UI-01 — Subdomain, Location Name, and Address fields are all read-only', async ({ page }) => {
    const signup = new SignupPage(page);
    await signup.goto();
    await signup.expectStep1Rendered();

    await expect(signup.subdomainInput).toHaveAttribute('readonly', '');
    await expect(page.locator('#locationName')).toHaveAttribute('readonly', '');
    await expect(page.locator('#locationAddress')).toHaveAttribute('readonly', '');
  });

  test('UI-03 — Show/Hide password button toggles input type on step 2', async ({ page }) => {
    const signup = new SignupPage(page);
    await signup.goto();
    await signup.expectStep1Rendered();

    // Get to step 2 (no submit — no account created)
    await signup.fillStep1({
      restaurantName: `MoonUI${uniqueSuffix()}`,
      fullName: 'Arslan UI',
      businessEmail: uniqueEmail('ui'),
      phoneNumber: '5555550199',
    });
    await signup.submitStep1();

    await signup.passwordInput.fill('Secret!2025');
    await expect(signup.passwordInput).toHaveAttribute('type', 'password');

    // Each field has its own toggle; click the one scoped to Password.
    await signup.passwordToggleButton.click();
    await expect(signup.passwordInput).toHaveAttribute('type', 'text');

    await signup.passwordToggleButton.click();
    await expect(signup.passwordInput).toHaveAttribute('type', 'password');
  });
});
