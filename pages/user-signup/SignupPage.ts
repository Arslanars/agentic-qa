import { type Locator, type Page, expect } from '@playwright/test';
import { BasePage } from '../BasePage';

export interface SignupStep1Data {
  restaurantName: string;
  fullName: string;
  businessEmail: string;
  phoneNumber: string;
}

export interface SignupStep2Data {
  password: string;
  confirmPassword: string;
}

export class SignupPage extends BasePage {
  readonly url = 'https://moontower.aiimone.com/signup';

  readonly step1Heading: Locator;
  readonly restaurantNameInput: Locator;
  readonly subdomainInput: Locator;
  readonly fullNameInput: Locator;
  readonly businessEmailInput: Locator;
  readonly phoneNumberInput: Locator;
  readonly nextButton: Locator;

  readonly step2Heading: Locator;
  readonly passwordInput: Locator;
  readonly confirmPasswordInput: Locator;
  // Each field has its own toggle — scope per-field to avoid strict-mode collisions.
  readonly passwordToggleButton: Locator;
  readonly confirmPasswordToggleButton: Locator;
  readonly termsCheckbox: Locator;
  readonly createAccountButton: Locator;
  readonly backButton: Locator;

  readonly signInLink: Locator;
  readonly backLink: Locator;

  constructor(page: Page) {
    super(page);
    this.step1Heading = page.getByRole('heading', { name: 'Register Your Restaurant' });
    this.restaurantNameInput = page.locator('#restaurantName');
    this.subdomainInput = page.locator('#subDomain');
    this.fullNameInput = page.locator('#adminFullName');
    this.businessEmailInput = page.locator('#adminEmail');
    this.phoneNumberInput = page.locator('#phoneNumber');
    this.nextButton = page.getByRole('button', { name: 'Next' });

    this.step2Heading = page.getByText('Set Password', { exact: true });
    this.passwordInput = page.getByRole('textbox', { name: 'Password', exact: true });
    this.confirmPasswordInput = page.getByRole('textbox', { name: 'Confirm Password' });
    // Step 2 has TWO show/hide-password toggles (one per field). Scope each
    // to its sibling textbox's container so they never collide with each
    // other under Playwright strict mode. Button text toggles between
    // "Show password" and "Hide password" when clicked.
    const toggleNameRe = /show password|hide password/i;
    this.passwordToggleButton = this.passwordInput.locator('..').getByRole('button', { name: toggleNameRe });
    this.confirmPasswordToggleButton = this.confirmPasswordInput.locator('..').getByRole('button', { name: toggleNameRe });
    this.termsCheckbox = page.getByRole('checkbox', { name: /I agree to the Terms/i });
    this.createAccountButton = page.getByRole('button', { name: 'Create Account' });
    this.backButton = page.getByRole('button', { name: 'Back' });

    this.signInLink = page.getByRole('link', { name: 'Sign in' });
    this.backLink = page.getByRole('link', { name: '← Back' });
  }

  async fillStep1(data: SignupStep1Data): Promise<void> {
    await this.restaurantNameInput.fill(data.restaurantName);
    await this.fullNameInput.fill(data.fullName);
    await this.businessEmailInput.fill(data.businessEmail);
    await this.phoneNumberInput.fill(data.phoneNumber);
  }

  async readSubdomain(): Promise<string> {
    return (await this.subdomainInput.inputValue()) || '';
  }

  async submitStep1(): Promise<void> {
    await this.nextButton.click();
    await expect(this.step2Heading).toBeVisible({ timeout: 10_000 });
  }

  async fillStep2(data: SignupStep2Data): Promise<void> {
    await this.passwordInput.fill(data.password);
    await this.confirmPasswordInput.fill(data.confirmPassword);
    await this.termsCheckbox.check();
  }

  async submitStep2(): Promise<void> {
    await expect(this.createAccountButton).toBeEnabled({ timeout: 5_000 });
    await this.createAccountButton.click();
  }

  async expectStep1Rendered(): Promise<void> {
    await expect(this.step1Heading).toBeVisible();
    await expect(this.nextButton).toBeVisible();
  }
}
