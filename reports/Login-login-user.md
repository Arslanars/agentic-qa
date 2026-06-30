# Execution Report — Login / Login User

<!-- agentic-qa:auto-start -->

**Last run:** 2026-06-30 16:45:15
**Browser:** chromium + firefox + webkit
**Status:** ✅ PASS (42/42)
**Duration:** 295.9 s

## Results

| Spec | Test | Browser | Status | Duration | Error |
|------|------|---------|--------|---------:|-------|
| `login.feature.spec.js` | Login User › AC1-POS-01 — successful login with valid credentials | `chromium` | ✅ PASS | 3.1 s | — |
| `login.feature.spec.js` | Login User › AC1-POS-01 — successful login with valid credentials | `firefox` | ✅ PASS | 5.0 s | — |
| `login.feature.spec.js` | Login User › AC1-POS-01 — successful login with valid credentials | `webkit` | ✅ PASS | 5.1 s | — |
| `login.feature.spec.js` | Login User › AC1-NEG-01 — wrong password is rejected | `chromium` | ✅ PASS | 3.1 s | — |
| `login.feature.spec.js` | Login User › AC1-NEG-01 — wrong password is rejected | `firefox` | ✅ PASS | 7.4 s | — |
| `login.feature.spec.js` | Login User › AC1-NEG-01 — wrong password is rejected | `webkit` | ✅ PASS | 5.3 s | — |
| `login.feature.spec.js` | Login User › AC1-NEG-02 — non-existent email is rejected | `chromium` | ✅ PASS | 4.1 s | — |
| `login.feature.spec.js` | Login User › AC1-NEG-02 — non-existent email is rejected | `firefox` | ✅ PASS | 4.4 s | — |
| `login.feature.spec.js` | Login User › AC1-NEG-02 — non-existent email is rejected | `webkit` | ✅ PASS | 4.2 s | — |
| `login.feature.spec.js` | Login User › AC1-NEG-03 — empty email is rejected | `chromium` | ✅ PASS | 12.5 s | — |
| `login.feature.spec.js` | Login User › AC1-NEG-03 — empty email is rejected | `firefox` | ✅ PASS | 19.2 s | — |
| `login.feature.spec.js` | Login User › AC1-NEG-03 — empty email is rejected | `webkit` | ✅ PASS | 13.2 s | — |
| `login.feature.spec.js` | Login User › AC1-NEG-04 — empty password is rejected | `chromium` | ✅ PASS | 12.0 s | — |
| `login.feature.spec.js` | Login User › AC1-NEG-04 — empty password is rejected | `firefox` | ✅ PASS | 13.6 s | — |
| `login.feature.spec.js` | Login User › AC1-NEG-04 — empty password is rejected | `webkit` | ✅ PASS | 13.2 s | — |
| `login.feature.spec.js` | Login User › AC1-NEG-05 — both fields empty are rejected | `chromium` | ✅ PASS | 13.1 s | — |
| `login.feature.spec.js` | Login User › AC1-NEG-05 — both fields empty are rejected | `firefox` | ✅ PASS | 15.7 s | — |
| `login.feature.spec.js` | Login User › AC1-NEG-05 — both fields empty are rejected | `webkit` | ✅ PASS | 13.3 s | — |
| `login.feature.spec.js` | Login User › AC1-NEG-06 — invalid email format (no @) flags typeMismatch | `chromium` | ✅ PASS | 12.4 s | — |
| `login.feature.spec.js` | Login User › AC1-NEG-06 — invalid email format (no @) flags typeMismatch | `firefox` | ✅ PASS | 13.7 s | — |
| `login.feature.spec.js` | Login User › AC1-NEG-06 — invalid email format (no @) flags typeMismatch | `webkit` | ✅ PASS | 13.8 s | — |
| `login.feature.spec.js` | Login User › AC1-NEG-07 — invalid email format (missing domain) flags typeMismatch | `chromium` | ✅ PASS | 12.1 s | — |
| `login.feature.spec.js` | Login User › AC1-NEG-07 — invalid email format (missing domain) flags typeMismatch | `firefox` | ✅ PASS | 14.6 s | — |
| `login.feature.spec.js` | Login User › AC1-NEG-07 — invalid email format (missing domain) flags typeMismatch | `webkit` | ✅ PASS | 13.4 s | — |
| `login.feature.spec.js` | Login User › UI-01 — password field is masked by default | `chromium` | ✅ PASS | 1.7 s | — |
| `login.feature.spec.js` | Login User › UI-01 — password field is masked by default | `firefox` | ✅ PASS | 2.3 s | — |
| `login.feature.spec.js` | Login User › UI-01 — password field is masked by default | `webkit` | ✅ PASS | 2.6 s | — |
| `login.feature.spec.js` | Login User › UI-02 — show/hide password button toggles the input type | `chromium` | ✅ PASS | 1.9 s | — |
| `login.feature.spec.js` | Login User › UI-02 — show/hide password button toggles the input type | `firefox` | ✅ PASS | 2.9 s | — |
| `login.feature.spec.js` | Login User › UI-02 — show/hide password button toggles the input type | `webkit` | ✅ PASS | 3.3 s | — |
| `login.feature.spec.js` | Login User › UI-03 — Enter key in the password field submits the form | `chromium` | ✅ PASS | 2.7 s | — |
| `login.feature.spec.js` | Login User › UI-03 — Enter key in the password field submits the form | `firefox` | ✅ PASS | 3.9 s | — |
| `login.feature.spec.js` | Login User › UI-03 — Enter key in the password field submits the form | `webkit` | ✅ PASS | 4.1 s | — |
| `login.feature.spec.js` | Login User › NAV-01 — "Forgot password?" link navigates to /forgot-password | `chromium` | ✅ PASS | 1.7 s | — |
| `login.feature.spec.js` | Login User › NAV-01 — "Forgot password?" link navigates to /forgot-password | `firefox` | ✅ PASS | 2.3 s | — |
| `login.feature.spec.js` | Login User › NAV-01 — "Forgot password?" link navigates to /forgot-password | `webkit` | ✅ PASS | 2.9 s | — |
| `login.feature.spec.js` | Login User › NAV-02 — "Sign up" link navigates to /signup | `chromium` | ✅ PASS | 2.3 s | — |
| `login.feature.spec.js` | Login User › NAV-02 — "Sign up" link navigates to /signup | `firefox` | ✅ PASS | 2.8 s | — |
| `login.feature.spec.js` | Login User › NAV-02 — "Sign up" link navigates to /signup | `webkit` | ✅ PASS | 2.6 s | — |
| `login.feature.spec.js` | Login User › NAV-03 — "← Back" link navigates to the homepage | `chromium` | ✅ PASS | 1.7 s | — |
| `login.feature.spec.js` | Login User › NAV-03 — "← Back" link navigates to the homepage | `firefox` | ✅ PASS | 3.3 s | — |
| `login.feature.spec.js` | Login User › NAV-03 — "← Back" link navigates to the homepage | `webkit` | ✅ PASS | 3.3 s | — |

## Artifacts

- [Playwright HTML report](../playwright-report/index.html)
- [Allure dashboard](../allure-report/index.html)
- Per-test screenshots under `test-results/login-user-*/`

> This block is regenerated on every run. Edit anywhere outside the markers to add notes that persist across runs.

<!-- agentic-qa:auto-end -->

**Date:** 2026-06-23
**Application:** https://moontower.aiimone.com/Login
**Story:** [user-stories/Login-login-user.md](../user-stories/Login-login-user.md)
**Plan:** [specs/Login-login-user-plan.md](../specs/Login-login-user-plan.md)

## Result

| Spec | AC | Status | Duration |
|------|----|--------|----------|
| `features/login-user/login.feature` (AC1-POS-01) | AC1 | ✅ PASS | ~5s |

**Total: 14 scenarios passed, 0 false greens.** (Migrated from `.spec.ts` to Gherkin.)

## What the suite proves

### AC1 — Visit site and try to login
The spec drives the Moontower login flow with the provided credentials:
1. Navigates to `https://moontower.aiimone.com/Login` and asserts the email field + Sign In button are visible.
2. Calls `LoginPage.login(email, password)` — fills email, fills password, clicks **Sign In**.
3. Asserts **three independent post-login signals** (all three must hold):
   - URL ends with `/select-location` (Moontower's canonical post-auth route)
   - Heading **"Select Your Location"** is visible
   - A **`Restaurant: <name>`** paragraph appears, confirming an account context was loaded

## Notable findings during exploration

1. **Shared post-auth screen.** Successful login lands on `/select-location` — the same route used after successful signup. Whatever flow gets the user authenticated (login or signup) routes them here to choose a location, which means this is the most reliable post-auth assertion target.

2. **Login form is simple and clean** — Email, Password (with Show-password toggle), Sign In, plus Forgot-password / Sign-up / Back links. No multi-step, no readonly fields like signup had.

3. **The test account `developers@moontower.com` is bound to "Demo Restaurant"** — the post-login screen shows `Restaurant: Demo Restaurant`. The spec uses a regex (`/^Restaurant:\s+/`) for the assertion so it doesn't break if the account is moved to another restaurant later; the strict literal match is intentionally avoided.

## How to re-run

```bash
# Just the login feature (BDD)
npx bddgen && npx playwright test .features-gen/features/login-user/ --project=chromium

# Or via the UI
npm run ui   # → http://localhost:3001 → pick "login-user" → ▶ Run Tests
```

To use different credentials without editing the steps:

```bash
MOONTOWER_LOGIN_EMAIL=other@user.com MOONTOWER_LOGIN_PASSWORD=mypass npm run test:chromium
```

## Hygiene checks (framework rules)

| Rule | Status |
|------|--------|
| Rule 1 — idempotent generation | ✅ POM/specs didn't exist; story stub was expanded in place (not regenerated) |
| Rule 2 — strict AC mapping | ✅ AC1 maps to one spec that directly asserts the AC's THEN clause |
| Rule 3 — no false greens | ✅ Three independent post-login signals must all hold; no `test.fail`, no `test.skip` |
| Rule 4 — review structure first | ✅ `LoginPage` extends `BasePage`, follows `pages/<feature>/<Name>Page.ts` convention |
| Rule 7 — update don't regenerate | ✅ The thin `Login-login-user.md` stub was expanded in place rather than overwritten with a fresh template |

## Artifacts

- POM: [pages/login-user/LoginPage.ts](../pages/login-user/LoginPage.ts)
- Feature: [features/login-user/login.feature](../features/login-user/login.feature)
- Step definitions: [features/login-user/login.steps.ts](../features/login-user/login.steps.ts)
- Playwright HTML report: `playwright-report/` (run `npx playwright show-report`)
- Per-test screenshots: `test-results/login-user-*/`
