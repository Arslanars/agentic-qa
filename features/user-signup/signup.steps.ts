// Step definitions for features/user-signup/signup.feature.
//
// Wraps the existing SignupPage POM — single source of truth for selectors.
// Destructive AC1 / AC2 scenarios are NOT replicated here: those specs
// create real production tenants and live behind a RUN_DESTRUCTIVE_SIGNUP
// gate in the classic .spec.ts version; the Gherkin layer mirrors only
// the non-destructive validation / UI / nav cases.

import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { SignupPage } from '../../pages/user-signup/SignupPage';

// Scope these step definitions to the @signup feature tag so phrases
// can overlap with other features without colliding.
const { Given, When, Then, test } = createBdd(null, { tags: '@signup' });

// Track per-scenario state we need to assert on later (e.g. the
// uniquely-generated restaurant name used in the post-signup screen).
let __lastRestaurantName: string | null = null;

const EMAIL_BASE = process.env.MOONTOWER_SIGNUP_EMAIL || 'arslan.moon@yopmail.com';
const PASSWORD = process.env.MOONTOWER_SIGNUP_PASSWORD || 'TestPass!2025';

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

function uniqueEmail(tag: string): string {
  const [local, domain] = EMAIL_BASE.split('@');
  return `${local}+${tag}${uniqueSuffix()}@${domain}`;
}

Given('I am on the Moontower signup page', async ({ page }) => {
  const signup = new SignupPage(page);
  await signup.goto();
  await signup.expectStep1Rendered();
});

// Gate for @destructive signup scenarios. AC1/AC2 happy-path scenarios call
// submitStep2() against production, minting a real tenant per run. Default
// runs skip these; opt in via RUN_DESTRUCTIVE_SIGNUP=1.
Given('destructive signup runs are explicitly enabled', async () => {
  test.skip(
    !process.env.RUN_DESTRUCTIVE_SIGNUP,
    'Destructive — creates a real tenant on the live host. Set RUN_DESTRUCTIVE_SIGNUP=1 to run.'
  );
});

When('I fill step 1 with a unique restaurant and valid contact details', async ({ page }) => {
  const signup = new SignupPage(page);
  const suffix = uniqueSuffix();
  __lastRestaurantName = `MoonGherkinDestr${suffix}`;
  await signup.fillStep1({
    restaurantName: __lastRestaurantName,
    fullName: 'Arslan Destructive',
    businessEmail: uniqueEmail(`destr-${suffix}`),
    phoneNumber: '5555550199',
  });
});

Then('the URL should leave \\/signup', async ({ page }) => {
  await expect(page).not.toHaveURL(/\/signup$/, { timeout: 15_000 });
});

Then('I should see the heading {string}', async ({ page }, name: string) => {
  await expect(page.getByRole('heading', { name })).toBeVisible();
});

Then('I should see a paragraph beginning with {string} referencing the new restaurant', async ({ page }, prefix: string) => {
  // Assert the prefix appears AND, if we captured a unique restaurant name
  // earlier in this scenario, that name is part of the visible text.
  if (__lastRestaurantName) {
    const re = new RegExp(prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+.*' + __lastRestaurantName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    await expect(page.getByText(re).first()).toBeVisible();
  } else {
    const re = new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+');
    await expect(page.getByText(re).first()).toBeVisible();
  }
});

// Step-1 form filling -------------------------------------------------------

When('I fill step 1 leaving the {string} field empty', async ({ page }, omitted: string) => {
  const signup = new SignupPage(page);
  const suffix = uniqueSuffix();
  const data: Record<string, string | undefined> = {
    'Restaurant Name': `MoonNeg${suffix}`,
    'Full Name': 'Arslan Tester',
    'Business Email': uniqueEmail('neg'),
    'Phone Number': '5555550199',
  };
  delete data[omitted];
  if (data['Restaurant Name']) await signup.restaurantNameInput.fill(data['Restaurant Name'] as string);
  if (data['Full Name']) await signup.fullNameInput.fill(data['Full Name'] as string);
  if (data['Business Email']) await signup.businessEmailInput.fill(data['Business Email'] as string);
  if (data['Phone Number']) await signup.phoneNumberInput.fill(data['Phone Number'] as string);
});

When('I fill step 1 with Business Email {string}', async ({ page }, email: string) => {
  const signup = new SignupPage(page);
  const suffix = uniqueSuffix();
  await signup.restaurantNameInput.fill(`MoonNeg${suffix}`);
  await signup.fullNameInput.fill('Arslan Tester');
  await signup.businessEmailInput.fill(email);
  await signup.phoneNumberInput.fill('5555550199');
});

When('I type {string} into the Restaurant Name field', async ({ page }, value: string) => {
  const signup = new SignupPage(page);
  await signup.restaurantNameInput.fill(value);
  await signup.restaurantNameInput.blur();
});

// Step-2 helpers ------------------------------------------------------------

When('I reach step 2 with valid step-1 data', async ({ page }) => {
  const signup = new SignupPage(page);
  const suffix = uniqueSuffix();
  await signup.fillStep1({
    restaurantName: `MoonGherkin${suffix}`,
    fullName: 'Arslan Gherkin',
    businessEmail: uniqueEmail(`gh-${suffix}`),
    phoneNumber: '5555550199',
  });
  await signup.submitStep1();
});

When('I enter matching passwords on step 2 without checking Terms', async ({ page }) => {
  const signup = new SignupPage(page);
  await signup.passwordInput.fill(PASSWORD);
  await signup.confirmPasswordInput.fill(PASSWORD);
  // Intentionally NOT checking the Terms checkbox.
});

When('I enter Password {string} and Confirm Password {string}', async ({ page }, pw: string, confirm: string) => {
  const signup = new SignupPage(page);
  await signup.passwordInput.fill(pw);
  await signup.confirmPasswordInput.fill(confirm);
});

When('I check the Terms checkbox', async ({ page }) => {
  const signup = new SignupPage(page);
  await signup.termsCheckbox.check();
});

When('I fill the Password field with {string}', async ({ page }, value: string) => {
  const signup = new SignupPage(page);
  await signup.passwordInput.fill(value);
});

When('I click the show-password toggle next to Password', async ({ page }) => {
  const signup = new SignupPage(page);
  await signup.passwordToggleButton.click();
});

// Generic actions -----------------------------------------------------------

When('I click {string}', async ({ page }, label: string) => {
  const signup = new SignupPage(page);
  if (label === 'Next') await signup.nextButton.click();
  else if (label === 'Create Account') {
    // If the button is enabled, click it; if disabled, this scenario expects
    // the click to be a no-op so we just attempt without waiting for enabled.
    await signup.createAccountButton.click({ force: true });
  } else throw new Error(`Unknown button label: ${label}`);
});

When('I click the {string} link', async ({ page }, label: string) => {
  const signup = new SignupPage(page);
  if (/sign in/i.test(label)) await signup.signInLink.click();
  else if (/back/i.test(label)) await signup.backLink.click();
  else throw new Error(`Unknown link label: ${label}`);
});

// Assertions ----------------------------------------------------------------

Then('the step-1 form should still be visible', async ({ page }) => {
  const signup = new SignupPage(page);
  await expect(signup.step1Heading).toBeVisible();
});

Then('the step-2 {string} form should not appear', async ({ page }, _heading: string) => {
  const signup = new SignupPage(page);
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
  await expect(signup.step2Heading).toBeHidden();
});

Then('the step-2 {string} form should still be visible', async ({ page }, _heading: string) => {
  const signup = new SignupPage(page);
  await expect(signup.step2Heading).toBeVisible();
});

Then('the Business Email field should report a typeMismatch validity error', async ({ page }) => {
  const signup = new SignupPage(page);
  // HTML5 validity is set after click+submit; press Tab to trigger blur first.
  await signup.businessEmailInput.blur();
  const isInvalid = await signup.businessEmailInput.evaluate(
    (el) => (el as HTMLInputElement).validity?.typeMismatch === true,
  );
  expect(isInvalid).toBe(true);
});

Then('the Subdomain field should have the readonly attribute', async ({ page }) => {
  const signup = new SignupPage(page);
  await expect(signup.subdomainInput).toHaveAttribute('readonly', '');
});

Then('the Subdomain value should be lowercase kebab-case', async ({ page }) => {
  const signup = new SignupPage(page);
  await expect(signup.subdomainInput).toHaveValue(/^[a-z0-9-]+$/, { timeout: 5000 });
});

Then('the Subdomain should contain {string}', async ({ page }, substr: string) => {
  const signup = new SignupPage(page);
  await expect(signup.subdomainInput).toHaveValue(new RegExp(substr, 'i'), { timeout: 5000 });
});

Then('the field {string} should have the readonly attribute', async ({ page }, id: string) => {
  await expect(page.locator(`#${id}`)).toHaveAttribute('readonly', '');
});

Then('the Create Account button should be disabled', async ({ page }) => {
  const signup = new SignupPage(page);
  await expect(signup.createAccountButton).toBeDisabled();
});

Then('the Terms checkbox should be unchecked', async ({ page }) => {
  const signup = new SignupPage(page);
  await expect(signup.termsCheckbox).not.toBeChecked();
});

Then('I should remain on the signup page', async ({ page }) => {
  await expect(page).toHaveURL(/\/signup$/i, { timeout: 5_000 });
});

Then('the Password field input type is {string}', async ({ page }, expected: string) => {
  const signup = new SignupPage(page);
  await expect(signup.passwordInput).toHaveAttribute('type', expected);
});

Then('the URL should match {string}', async ({ page }, pattern: string) => {
  await expect(page).toHaveURL(new RegExp(pattern), { timeout: 10_000 });
});

Then('the URL should match the homepage', async ({ page }) => {
  await expect(page).toHaveURL(/^https?:\/\/[^/]+\/?$/, { timeout: 10_000 });
});
