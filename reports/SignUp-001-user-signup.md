# Execution Report — SignUp-001 / User Signup

<!-- agentic-qa:auto-start -->

**Last run:** 2026-06-26 13:11:14
**Browser:** chromium
**Status:** ✅ PASS (2/2)
**Duration:** 32.3 s

## Results

| Spec | Test | Status | Duration | Error |
|------|------|--------|---------:|-------|
| `fill-and-submit.spec.ts` | SignUp-001 / AC1: fill the signup form and register a new user › AC1 — fills both steps and the app accepts the registration (URL leaves /signup) | ✅ PASS | 16.1 s | — |
| `verify-registered.spec.ts` | SignUp-001 / AC2: verify the user is registered › AC2 — after Create Account, the app surfaces the post-registration screen referencing the new restaurant | ✅ PASS | 16.2 s | — |

## Artifacts

- [Playwright HTML report](../playwright-report/index.html)
- [Allure dashboard](../allure-report/index.html)
- Per-test screenshots under `test-results/user-signup-*/`

> This block is regenerated on every run. Edit anywhere outside the markers to add notes that persist across runs.

<!-- agentic-qa:auto-end -->

**Date:** 2026-06-23
**Application:** https://moontower.aiimone.com/signup
**Story:** [user-stories/SignUp-001-user-signup.md](../user-stories/SignUp-001-user-signup.md)
**Plan:** [specs/SignUp-001-user-signup-plan.md](../specs/SignUp-001-user-signup-plan.md)

## Result

| Spec | AC | Status | Duration |
|------|----|--------|----------|
| `tests/user-signup/fill-and-submit.spec.ts` | AC1 | ✅ PASS | 3.5s |
| `tests/user-signup/verify-registered.spec.ts` | AC2 | ✅ PASS | 3.5s |

**Total: 2 passed, 5.0s, 0 false greens.**

## What the suite proves

### AC1 — Visit the site and fill the signup form and registered as new user
The spec drives the full 2-step Moontower signup flow with valid data:
1. Fills the editable step-1 fields (Restaurant Name, Full Name, Business Email, Phone Number).
2. Asserts the **read-only Subdomain auto-populates** from Restaurant Name — proving the app's derived-state logic was triggered.
3. Clicks **Next** and asserts the step-2 "Set Password" surface renders.
4. Fills Password + Confirm Password, ticks the Terms checkbox.
5. Clicks **Create Account** and asserts the URL **leaves `/signup`** — i.e., the server accepted the registration.

### AC2 — Verify the user is registered
The spec drives the same flow, then asserts **three independent post-registration signals** (all three must hold):
1. URL is exactly `/select-location` (Moontower's post-signup landing route).
2. Heading **"Select Your Location"** is visible.
3. The literal text **"Restaurant: &lt;run-specific name&gt;"** appears — proving the exact account just created is what the server registered (not a stale screen from a prior test).

## Notable findings during exploration

1. **Three step-1 fields are `readonly`** (despite appearing as plain textboxes in the accessibility snapshot):
   - `#subDomain` — auto-derived from Restaurant Name
   - `#locationName` — system-managed
   - `#locationAddress` — system-managed

   Tests must not call `.fill()` on these; the POM only exposes the four editable fields.

2. **Step 2 (Set Password) is only visible after clicking Next.** It requires Password + Confirm Password + Terms checkbox before the **Create Account** button enables. The POM waits for the step-2 heading to render before returning from `submitStep1()`.

3. **Success state:** `/signup` → `/select-location`. The post-registration screen shows "Restaurant: &lt;name&gt;" — a strong, run-specific assertion target.

4. **Email uniqueness is enforced server-side.** The provided `arslan.moon@yopmail.com` works exactly once. To keep the suite idempotent the specs use yopmail `+tag` aliases (`arslan.moon+ac1<suffix>@yopmail.com`), which yopmail forwards to the same inbox — fresh email per run, same inbox to inspect.

## How to re-run

```bash
# All AC specs for this feature
npx playwright test tests/user-signup --project=chromium

# Or via the UI
npm run ui   # → http://localhost:3001 → pick "User signup" → ▶ Run Tests
```

## Hygiene checks (framework rules)

| Rule | Status |
|------|--------|
| Rule 1 — idempotent generation (no overwrite of existing feature) | ✅ Fresh feature; nothing existed |
| Rule 2 — strict AC mapping (one spec per AC, asserts the AC directly) | ✅ AC1 / AC2 each have a dedicated spec with direct assertions |
| Rule 3 — no false greens (failures must be loud, not skipped/test.fail-papered) | ✅ Both pass via real post-registration signals — no `test.fail`, no `test.skip` |
| Rule 4 — review structure first (extend `BasePage`, follow POM conventions) | ✅ `SignupPage` extends `BasePage`, follows `pages/<feature>/<Name>Page.ts` convention |

## Artifacts

- POM: [pages/user-signup/SignupPage.ts](../pages/user-signup/SignupPage.ts)
- AC1 spec: [tests/user-signup/fill-and-submit.spec.ts](../tests/user-signup/fill-and-submit.spec.ts)
- AC2 spec: [tests/user-signup/verify-registered.spec.ts](../tests/user-signup/verify-registered.spec.ts)
- Playwright HTML report: `playwright-report/` (run `npx playwright show-report`)
- Per-test screenshots: `test-results/user-signup-*/`
