# Execution Report — Login / Login User

<!-- agentic-qa:auto-start -->

**Last run:** 2026-06-28 11:23:59
**Browser:** chromium
**Status:** ✅ PASS (14/14)
**Duration:** 111.1 s

## Results

| Spec | Test | Status | Duration | Error |
|------|------|--------|---------:|-------|
| `login.feature.spec.js` | Login User › AC1-POS-01 — successful login with valid credentials | ✅ PASS | 4.7 s | — |
| `login.feature.spec.js` | Login User › AC1-NEG-01 — wrong password is rejected | ✅ PASS | 4.6 s | — |
| `login.feature.spec.js` | Login User › AC1-NEG-02 — non-existent email is rejected | ✅ PASS | 4.2 s | — |
| `login.feature.spec.js` | Login User › AC1-NEG-03 — empty email is rejected | ✅ PASS | 13.4 s | — |
| `login.feature.spec.js` | Login User › AC1-NEG-04 — empty password is rejected | ✅ PASS | 16.3 s | — |
| `login.feature.spec.js` | Login User › AC1-NEG-05 — both fields empty are rejected | ✅ PASS | 13.2 s | — |
| `login.feature.spec.js` | Login User › AC1-NEG-06 — invalid email format (no @) flags typeMismatch | ✅ PASS | 17.0 s | — |
| `login.feature.spec.js` | Login User › AC1-NEG-07 — invalid email format (missing domain) flags typeMismatch | ✅ PASS | 13.2 s | — |
| `login.feature.spec.js` | Login User › UI-01 — password field is masked by default | ✅ PASS | 3.6 s | — |
| `login.feature.spec.js` | Login User › UI-02 — show/hide password button toggles the input type | ✅ PASS | 3.5 s | — |
| `login.feature.spec.js` | Login User › UI-03 — Enter key in the password field submits the form | ✅ PASS | 6.1 s | — |
| `login.feature.spec.js` | Login User › NAV-01 — "Forgot password?" link navigates to /forgot-password | ✅ PASS | 5.0 s | — |
| `login.feature.spec.js` | Login User › NAV-02 — "Sign up" link navigates to /signup | ✅ PASS | 3.0 s | — |
| `login.feature.spec.js` | Login User › NAV-03 — "← Back" link navigates to the homepage | ✅ PASS | 3.2 s | — |

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
| `tests/login-user/login-success.spec.ts` | AC1 | ✅ PASS | 3.6s |

**Total: 1 passed, 5.1s, 0 false greens.**

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
# Just the login spec
npx playwright test tests/login-user --project=chromium

# Or via the UI
npm run ui   # → http://localhost:3001 → pick "Login user" → ▶ Run Tests
```

To use different credentials without editing the spec:

```bash
MOONTOWER_LOGIN_EMAIL=other@user.com MOONTOWER_LOGIN_PASSWORD=mypass npx playwright test tests/login-user
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
- Spec: [tests/login-user/login-success.spec.ts](../tests/login-user/login-success.spec.ts)
- Playwright HTML report: `playwright-report/` (run `npx playwright show-report`)
- Per-test screenshots: `test-results/login-user-*/`
