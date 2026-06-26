import { test, expect } from '@playwright/test';
import { SignupPage } from '../../pages/user-signup/SignupPage';

const EMAIL_BASE = process.env.MOONTOWER_SIGNUP_EMAIL || 'arslan.moon@yopmail.com';
const PASSWORD = process.env.MOONTOWER_SIGNUP_PASSWORD || 'TestPass!2025';

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

// yopmail forwards `local+tag@yopmail.com` to the `local@yopmail.com` inbox,
// so each run gets a unique email the server hasn't seen while everything still
// lands in the same inbox we can inspect manually.
function uniqueEmail(tag: string): string {
  const [local, domain] = EMAIL_BASE.split('@');
  return `${local}+${tag}${uniqueSuffix()}@${domain}`;
}

test.describe('SignUp-001 / AC1: fill the signup form and register a new user', () => {
  test('AC1 — fills both steps and the app accepts the registration (URL leaves /signup)', async ({ page }) => {
    const signup = new SignupPage(page);
    await signup.goto();
    await signup.expectStep1Rendered();

    const suffix = uniqueSuffix();
    const restaurantName = `MoonTest${suffix}`;
    const email = uniqueEmail('ac1');
    await signup.fillStep1({
      restaurantName,
      fullName: 'Arslan Tester',
      businessEmail: email,
      phoneNumber: '5555550199',
    });

    expect(await signup.readSubdomain(), 'Subdomain should auto-populate from Restaurant Name').not.toBe('');

    await signup.submitStep1();

    await signup.fillStep2({ password: PASSWORD, confirmPassword: PASSWORD });
    await signup.submitStep2();

    // AC1 succeeds if the app accepts the registration and navigates away from /signup.
    await expect(page).not.toHaveURL(/\/signup$/, { timeout: 15_000 });
    expect(page.url(), 'After Create Account, the URL should leave /signup — otherwise the form was rejected').not.toMatch(/\/signup$/);
  });
});
