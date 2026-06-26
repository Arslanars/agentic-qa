# Test Plan: Login — Login User

## Application
- URL: https://moontower.aiimone.com/Login
- Title: "MoonTower - Restaurant Inventory Management"
- Form: single screen — **Email**, **Password** (with Show-password toggle), **Sign In** button, **Forgot password?** link, **Sign up** link.
- **Success state:** `/select-location` with heading "Select Your Location" and a "Restaurant: &lt;name&gt;" paragraph.

## Acceptance Criteria → Spec mapping

| AC | Spec file | What it asserts |
|----|-----------|-----------------|
| AC1: Visit site and try to login | `tests/login-user/login-success.spec.ts` | After submitting valid credentials, the app routes to `/select-location`, the "Select Your Location" heading is visible, and a "Restaurant: …" paragraph confirms an account context loaded. |

## Test data
- `MOONTOWER_LOGIN_EMAIL` env var → defaults to `developers@moontower.com`
- `MOONTOWER_LOGIN_PASSWORD` env var → defaults to `12345678`

## Page Object
- `pages/login-user/LoginPage.ts` — extends `BasePage`
- Role-based locators (`getByRole`) — stable against minor markup changes
- Exposes `login(email, password)`, `expectLoaded()`

## Out of scope
- Negative login (wrong creds) — AC only requires "try to login" with provided creds, so we test the happy path only. Adding negative coverage would require an extra AC.
- Forgot-password and signup links — present in the POM but not exercised by AC1.
