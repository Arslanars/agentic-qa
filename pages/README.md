# Page Object Model (POM)

This folder holds **page objects** — one TypeScript class per page or major UI component. Tests interact with the app **through these classes** instead of touching `page.locator(...)` directly. The goal is to keep locators and interaction logic in one place, so a UI change touches one file instead of fifty.

## Conventions

| Rule | Why |
|------|-----|
| One class per page → `pages/<feature>/<PageName>Page.ts` | Mirrors `tests/<feature>/` layout — easy to find. |
| All page classes extend [`BasePage`](BasePage.ts) | Shared navigation, screenshotting, and assertions. |
| Locators are `readonly Locator` properties initialized in the constructor | One source of truth per selector. |
| Action methods are named after user intent (`login()`, `addToCart()`), not selectors | Tests read like specifications. |
| Navigation actions return the next page object | `await loginPage.submit()` → `DashboardPage`. |
| Do **not** put `expect()` assertions on success paths inside page objects | Assertions belong in tests. (Exception: helper `expect…` methods are OK if the same check is reused in many tests.) |
| Prefer role-based selectors over CSS where possible | More stable, more accessible. |

## File layout

```
pages/
├── BasePage.ts                       # Abstract base — extend this
├── README.md                         # You are here
└── <feature>/                        # One folder per feature, mirrors tests/<feature>/
    ├── LoginPage.ts
    ├── DashboardPage.ts
    └── …
```

## Example — LoginPage

```typescript
// pages/auth/LoginPage.ts
import { type Locator, type Page } from '@playwright/test';
import { BasePage } from '../BasePage';

export class LoginPage extends BasePage {
  readonly url = 'https://example.com/login';

  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly submitButton: Locator;
  readonly errorToast: Locator;
  readonly emailFieldError: Locator;
  readonly passwordFieldError: Locator;

  constructor(page: Page) {
    super(page);
    this.emailInput = page.getByRole('textbox', { name: 'Email' });
    this.passwordInput = page.getByRole('textbox', { name: 'Password' });
    this.submitButton = page.getByRole('button', { name: 'Sign In' });
    this.errorToast = page.getByText('Invalid email or password.');
    this.emailFieldError = page.getByText('Please enter a valid email address');
    this.passwordFieldError = page.getByText('Password must be at least 8 characters');
  }

  async login(email: string, password: string): Promise<void> {
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
  }

  async submitEmpty(): Promise<void> {
    await this.submitButton.click();
  }
}
```

## Example — using the POM in a test

```typescript
// tests/auth/invalid-credentials.spec.ts
import { test, expect } from '@playwright/test';
import { LoginPage } from '../../pages/auth/LoginPage';

test.describe('Login - invalid credentials', () => {
  test('shows error toast and stays on /login', async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login('invalid@test.com', 'WrongPass!');

    await expect(loginPage.errorToast).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });
});
```

## When NOT to use a page object

- Single-use, one-line interactions in a single test.
- Pure assertions on URL or page title.
- Tests that exist to verify the page object itself (rare).

If a locator appears in **two or more** tests, move it to a page object.
