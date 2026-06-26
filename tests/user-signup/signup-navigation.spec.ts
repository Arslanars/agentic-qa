import { test, expect } from '@playwright/test';
import { SignupPage } from '../../pages/user-signup/SignupPage';

test.describe('SignUp / Navigation', () => {
  test('NAV-01 — "Sign in" link navigates to /login', async ({ page }) => {
    const signup = new SignupPage(page);
    await signup.goto();
    await signup.expectStep1Rendered();

    await expect(signup.signInLink).toHaveAttribute('href', /\/login$/i);
    await signup.signInLink.click();
    await expect(page).toHaveURL(/\/login$/i, { timeout: 10_000 });
  });

  test('NAV-02 — "← Back" link navigates to the homepage', async ({ page }) => {
    const signup = new SignupPage(page);
    await signup.goto();
    await signup.expectStep1Rendered();

    await expect(signup.backLink).toHaveAttribute('href', '/');
    await signup.backLink.click();
    await expect(page).toHaveURL(/^https?:\/\/[^/]+\/?$/, { timeout: 10_000 });
  });
});
