import { test, expect } from '@playwright/test';
import { LoginPage } from '../../pages/login-user/LoginPage';

test.describe('Login / Navigation — secondary links', () => {
  test('NAV-01 — "Forgot password?" link navigates to /forgot-password', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await login.expectLoaded();

    await expect(login.forgotPasswordLink).toHaveAttribute('href', /\/forgot-password$/);
    await login.forgotPasswordLink.click();
    await expect(page).toHaveURL(/\/forgot-password$/, { timeout: 10_000 });
  });

  test('NAV-02 — "Sign up" link navigates to /signup', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await login.expectLoaded();

    await expect(login.signUpLink).toHaveAttribute('href', /\/signup$/);
    await login.signUpLink.click();
    await expect(page).toHaveURL(/\/signup$/, { timeout: 10_000 });
  });

  test('NAV-03 — "← Back" link navigates to the homepage', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await login.expectLoaded();

    await expect(login.backLink).toHaveAttribute('href', '/');
    await login.backLink.click();
    await expect(page).toHaveURL(/^https?:\/\/[^/]+\/?$/, { timeout: 10_000 });
  });
});
