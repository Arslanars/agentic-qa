import { test, expect } from '@playwright/test';
import { LoginPage } from '../../pages/login-user/LoginPage';

const EMAIL = process.env.MOONTOWER_LOGIN_EMAIL || 'developers@moontower.com';
const PASSWORD = process.env.MOONTOWER_LOGIN_PASSWORD || '12345678';

test.describe('Login / AC1: visit site and try to login', () => {
  test('AC1 — valid credentials authenticate the user and route them to /select-location', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await login.expectLoaded();

    await login.login(EMAIL, PASSWORD);

    // Three independent post-login signals — all must hold:
    //  (1) URL ends with /select-location (Moontower's canonical post-auth route)
    //  (2) "Select Your Location" heading is visible
    //  (3) The "Restaurant:" paragraph appears, confirming an account context was loaded
    await expect(page).toHaveURL(/\/select-location$/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Select Your Location' })).toBeVisible();
    await expect(page.getByText(/^Restaurant:\s+/)).toBeVisible();
  });
});
