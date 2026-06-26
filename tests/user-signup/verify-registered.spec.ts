import { test, expect } from '@playwright/test';
import { SignupPage } from '../../pages/user-signup/SignupPage';

const EMAIL_BASE = process.env.MOONTOWER_SIGNUP_EMAIL || 'arslan.moon@yopmail.com';
const PASSWORD = process.env.MOONTOWER_SIGNUP_PASSWORD || 'TestPass!2025';

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

function uniqueEmail(tag: string): string {
  const [local, domain] = EMAIL_BASE.split('@');
  return `${local}+${tag}${uniqueSuffix()}@${domain}`;
}

test.describe('SignUp-001 / AC2: verify the user is registered', () => {
  // Same destructive-gate as AC1 — see fill-and-submit.spec.ts.
  test.skip(
    !process.env.RUN_DESTRUCTIVE_SIGNUP,
    'Destructive — creates a real tenant on the live host. Set RUN_DESTRUCTIVE_SIGNUP=1 to run.'
  );

  test('AC2 — after Create Account, the app surfaces the post-registration screen referencing the new restaurant', async ({ page }) => {
    const signup = new SignupPage(page);
    await signup.goto();
    await signup.expectStep1Rendered();

    const suffix = uniqueSuffix();
    const restaurantName = `MoonVerify${suffix}`;
    const email = uniqueEmail('ac2');
    await signup.fillStep1({
      restaurantName,
      fullName: 'Arslan Verify',
      businessEmail: email,
      phoneNumber: '5555550199',
    });
    await signup.submitStep1();

    await signup.fillStep2({ password: PASSWORD, confirmPassword: PASSWORD });
    await signup.submitStep2();

    // Three independent signals MUST all hold for AC2:
    //  (1) URL is /select-location — the post-registration landing route
    //  (2) "Select Your Location" heading is visible
    //  (3) "Restaurant: <name>" confirms THIS run's account was the one registered
    await expect(page).toHaveURL(/\/select-location$/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Select Your Location' })).toBeVisible();
    await expect(page.getByText(`Restaurant: ${restaurantName}`)).toBeVisible();
  });
});
