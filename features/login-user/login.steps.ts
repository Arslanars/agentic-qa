// Step definitions for features/login-user/login.feature.
//
// Implementation note: steps wrap the existing LoginPage POM so we never
// duplicate selectors. The Gherkin layer is a thin DSL on top of the
// proven object model — adding scenarios = adding rows, not new code.

import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { LoginPage } from '../../pages/login-user/LoginPage';

// Scope these step definitions to the @login feature tag so the same
// step phrases (e.g. `I click the {string} link`) can be redefined for
// other features without colliding with Cucumber's global step pool.
const { Given, When, Then } = createBdd(undefined, { tags: '@login' });

const AUTH_API_RE = /security-api\.moontower\.aiimone\.com\/api\/Auth\/Login/i;

Given('I am on the Moontower login page', async ({ page }) => {
  const login = new LoginPage(page);
  await login.goto();
  await login.expectLoaded();
});

When('I sign in with email {string} and password {string}', async ({ page }, email: string, password: string) => {
  const login = new LoginPage(page);
  // Wire the auth-API response BEFORE the click so negative tests can assert on the response status.
  const responsePromise = page.waitForResponse((r) => AUTH_API_RE.test(r.url()), { timeout: 10_000 }).catch(() => null);
  // Allow empty strings — the negative case sends them deliberately.
  if (email) await login.emailInput.fill(email);
  if (password) await login.passwordInput.fill(password);
  await login.signInButton.click();
  // Stash the response on the page so later steps can assert on it.
  (page as any).__lastAuthResponse = await responsePromise;
});

When('I sign in with a randomly-generated email and password {string}', async ({ page }, password: string) => {
  const login = new LoginPage(page);
  const responsePromise = page.waitForResponse((r) => AUTH_API_RE.test(r.url()), { timeout: 10_000 }).catch(() => null);
  await login.emailInput.fill(`no-such-user-${Date.now().toString(36)}@example.com`);
  await login.passwordInput.fill(password);
  await login.signInButton.click();
  (page as any).__lastAuthResponse = await responsePromise;
});

When('I fill the login form with email {string} and password {string}', async ({ page }, email: string, password: string) => {
  const login = new LoginPage(page);
  await login.emailInput.fill(email);
  await login.passwordInput.fill(password);
});

When('I press Enter in the password field', async ({ page }) => {
  const login = new LoginPage(page);
  await login.passwordInput.press('Enter');
});

When('I type {string} into the password field', async ({ page }, value: string) => {
  const login = new LoginPage(page);
  await login.passwordInput.fill(value);
});

When('I click the {string} toggle', async ({ page }, _label: string) => {
  // Login page only has one toggle; ignore the label and click it.
  const login = new LoginPage(page);
  await login.showPasswordButton.click();
});

When('I click the {string} link', async ({ page }, label: string) => {
  const login = new LoginPage(page);
  if (/forgot/i.test(label)) await login.forgotPasswordLink.click();
  else if (/sign up/i.test(label)) await login.signUpLink.click();
  else if (/back/i.test(label)) await login.backLink.click();
  else throw new Error(`Unknown link label: ${label}`);
});

Then('I should be redirected to the location-picker screen', async ({ page }) => {
  await expect(page).toHaveURL(/\/select-location$/, { timeout: 15_000 });
});

Then('I should not be redirected to the location-picker screen', async ({ page }) => {
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
  await expect(page).not.toHaveURL(/\/select-location/, { timeout: 5_000 });
});

Then('I should remain on the login page', async ({ page }) => {
  await expect(page).toHaveURL(/\/login$/i, { timeout: 5_000 });
});

Then('the auth API should return a non-2xx response', async ({ page }) => {
  const resp = (page as any).__lastAuthResponse;
  expect(resp, 'expected an auth-API response to be captured').not.toBeNull();
  expect(resp.ok(), `Auth API should reject (got ${resp.status()})`).toBe(false);
});

Then('I should see the heading {string}', async ({ page }, name: string) => {
  await expect(page.getByRole('heading', { name })).toBeVisible();
});

Then('I should see a paragraph beginning with {string}', async ({ page }, prefix: string) => {
  // Match a text node starting with the prefix (any whitespace after).
  const re = new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+');
  await expect(page.getByText(re).first()).toBeVisible();
});

Then('the password field input type is {string}', async ({ page }, expected: string) => {
  const login = new LoginPage(page);
  await expect(login.passwordInput).toHaveAttribute('type', expected);
});

Then('the email field should report a typeMismatch validity error', async ({ page }) => {
  const login = new LoginPage(page);
  // Poll instead of single evaluate() so a transient navigation/teardown
  // race (Firefox sometimes tears down the page while we sample) doesn't
  // immediately fail the step.
  await expect
    .poll(
      async () => login.emailInput.evaluate((el) => (el as HTMLInputElement).validity?.typeMismatch === true),
      { timeout: 5_000, message: 'Email input should flag typeMismatch on bad-format inputs' },
    )
    .toBe(true);
});

Then('the URL should match {string}', async ({ page }, pattern: string) => {
  await expect(page).toHaveURL(new RegExp(pattern), { timeout: 10_000 });
});

Then('the URL should match the homepage', async ({ page }) => {
  await expect(page).toHaveURL(/^https?:\/\/[^/]+\/?$/, { timeout: 10_000 });
});
