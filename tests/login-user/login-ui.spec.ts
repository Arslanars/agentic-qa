import { test, expect } from '@playwright/test';
import { LoginPage } from '../../pages/login-user/LoginPage';

const VALID_EMAIL = process.env.MOONTOWER_LOGIN_EMAIL || 'developers@moontower.com';
const VALID_PASSWORD = process.env.MOONTOWER_LOGIN_PASSWORD || '12345678';

test.describe('Login / UI — form behavior', () => {
  test('UI-01 — password field has type="password" by default (input is masked)', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await login.expectLoaded();
    await expect(login.passwordInput).toHaveAttribute('type', 'password');
  });

  test('UI-02 — "Show password" button toggles input type between password and text', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await login.expectLoaded();

    await login.passwordInput.fill('Secret!2025');
    await expect(login.passwordInput).toHaveAttribute('type', 'password');

    await login.showPasswordButton.click();
    await expect(login.passwordInput).toHaveAttribute('type', 'text');

    // Toggling again re-masks
    await login.showPasswordButton.click();
    await expect(login.passwordInput).toHaveAttribute('type', 'password');
  });

  test('UI-03 — pressing Enter inside the password field submits the form', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await login.expectLoaded();

    await login.emailInput.fill(VALID_EMAIL);
    await login.passwordInput.fill(VALID_PASSWORD);

    // Press Enter while focus is on the password field — should trigger submit
    await login.passwordInput.press('Enter');

    // Successful submit lands on /select-location (same as clicking Sign In)
    await expect(page).toHaveURL(/\/select-location$/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Select Your Location' })).toBeVisible();
  });
});
