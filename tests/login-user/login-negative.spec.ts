import { test, expect } from '@playwright/test';
import { LoginPage } from '../../pages/login-user/LoginPage';

const VALID_EMAIL = process.env.MOONTOWER_LOGIN_EMAIL || 'developers@moontower.com';
const AUTH_API_RE = /security-api\.moontower\.aiimone\.com\/api\/Auth\/Login/i;

// Moontower's auth endpoint returns 401 for any rejected credential set
// (wrong password, non-existent email, malformed payload). Empty client-side
// fields still POST — the server simply rejects. There is no visible toast,
// so we assert via (a) URL stays on /login (case-insensitive) and (b) the
// auth API returned a non-2xx response when it was called.

test.describe('Login / AC1: NEGATIVE — rejected credential cases', () => {
  test('AC1-NEG-01 — wrong password: URL stays on /login and auth API returns non-2xx', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await login.expectLoaded();

    const responsePromise = page.waitForResponse(
      (r) => AUTH_API_RE.test(r.url()),
      { timeout: 10_000 },
    );
    await login.login(VALID_EMAIL, 'WrongPassword!2025');
    const response = await responsePromise;

    expect(response.ok(), `Auth API should reject wrong password (got ${response.status()})`).toBe(false);
    await expect(page).toHaveURL(/\/login$/i, { timeout: 5_000 });
    await expect(page.getByRole('heading', { name: 'Select Your Location' })).toBeHidden();
  });

  test('AC1-NEG-02 — non-existent email: URL stays on /login and auth API returns non-2xx', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await login.expectLoaded();

    const responsePromise = page.waitForResponse(
      (r) => AUTH_API_RE.test(r.url()),
      { timeout: 10_000 },
    );
    await login.login(`no-such-user-${Date.now()}@example.com`, 'AnyPass!1234');
    const response = await responsePromise;

    expect(response.ok(), `Auth API should reject unknown email (got ${response.status()})`).toBe(false);
    await expect(page).toHaveURL(/\/login$/i, { timeout: 5_000 });
  });

  test('AC1-NEG-03 — empty email: no redirect to /select-location', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await login.expectLoaded();

    await login.passwordInput.fill('Whatever!2025');
    await login.signInButton.click();

    await page.waitForTimeout(1500);
    await expect(page).not.toHaveURL(/\/select-location/, { timeout: 5_000 });
    await expect(login.signInButton).toBeVisible();
  });

  test('AC1-NEG-04 — empty password: no redirect to /select-location', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await login.expectLoaded();

    await login.emailInput.fill(VALID_EMAIL);
    await login.signInButton.click();

    await page.waitForTimeout(1500);
    await expect(page).not.toHaveURL(/\/select-location/, { timeout: 5_000 });
    await expect(login.signInButton).toBeVisible();
  });

  test('AC1-NEG-05 — both fields empty: no redirect to /select-location', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await login.expectLoaded();

    await login.signInButton.click();

    await page.waitForTimeout(1500);
    await expect(page).not.toHaveURL(/\/select-location/, { timeout: 5_000 });
    await expect(login.signInButton).toBeVisible();
  });

  test('AC1-NEG-06 — invalid email format (no @): submission rejected, no redirect', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await login.expectLoaded();

    await login.emailInput.fill('developersmoontower.com');
    await login.passwordInput.fill('Whatever!2025');
    await login.signInButton.click();

    await page.waitForTimeout(1500);
    await expect(page).not.toHaveURL(/\/select-location/, { timeout: 5_000 });
    // The browser's HTML5 validity check on input[type=email] should reject this.
    const isInvalid = await login.emailInput.evaluate(
      (el) => (el as HTMLInputElement).validity?.typeMismatch === true,
    );
    expect(isInvalid, 'Email input should report typeMismatch validity for "developersmoontower.com"').toBe(true);
  });

  test('AC1-NEG-07 — invalid email format (missing domain): submission rejected, no redirect', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await login.expectLoaded();

    await login.emailInput.fill('developers@');
    await login.passwordInput.fill('Whatever!2025');
    await login.signInButton.click();

    await page.waitForTimeout(1500);
    await expect(page).not.toHaveURL(/\/select-location/, { timeout: 5_000 });
    const isInvalid = await login.emailInput.evaluate(
      (el) => (el as HTMLInputElement).validity?.typeMismatch === true,
    );
    expect(isInvalid, 'Email input should report typeMismatch validity for "developers@"').toBe(true);
  });
});
