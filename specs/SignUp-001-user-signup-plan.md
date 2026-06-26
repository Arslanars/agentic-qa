# Test Plan: SignUp-001 — User Signup

## Application
- URL: https://moontower.aiimone.com/signup
- Title: "MoonTower - Restaurant Inventory Management"
- Form: **2-step**.
  - **Step 1** ("Register Your Restaurant"):
    - **Editable:** Restaurant Name (`#restaurantName`), Full Name (`#adminFullName`), Business Email (`#adminEmail`), Phone Number (`#phoneNumber`)
    - **Read-only (auto-populated or system-managed):** Subdomain (`#subDomain` — derives from Restaurant Name), Location Name, Address
    - Primary action: **Next** button → advances to step 2
  - **Step 2** ("Set Password"):
    - **Editable:** Password, Confirm Password, Terms checkbox
    - Primary action: **Create Account** button (disabled until passwords + terms are valid)
  - **Post-submit (success state):** redirects to `/select-location` with heading "Select Your Location" and a paragraph "Restaurant: &lt;name&gt;" confirming the new account.

## Acceptance Criteria → Spec mapping

| AC | Spec file | What it asserts |
|----|-----------|-----------------|
| AC1: Visit + fill + register | `tests/user-signup/fill-and-submit.spec.ts` | Drives the full 2-step flow with valid data and asserts the app navigates **away** from `/signup` after Create Account — i.e. the server accepted the registration. Also asserts Subdomain auto-populates from Restaurant Name. |
| AC2: Verify user is registered | `tests/user-signup/verify-registered.spec.ts` | Drives the full flow and asserts **all three** post-registration signals: URL `/select-location`, heading "Select Your Location" visible, and the literal `Restaurant: <run-specific name>` text — the third proves the exact account just created is what the server registered. |

## Test data
- `MOONTOWER_SIGNUP_EMAIL` env var, defaulting to `arslan.moon@yopmail.com`
- `MOONTOWER_SIGNUP_PASSWORD` env var, defaulting to `TestPass!2025`
- Restaurant Name includes a `Date.now().toString(36)` suffix so each run gets a unique tenant/subdomain (the subdomain is auto-derived from the name, so uniqueness flows through)

## Page Object
- `pages/user-signup/SignupPage.ts` — extends `BasePage`
- Mix of `#id` selectors (for fields whose labels collide or are unreliable) and `getByRole` selectors (for buttons/headings)
- Exposes the full flow: `expectStep1Rendered()`, `fillStep1(data)`, `readSubdomain()`, `submitStep1()`, `fillStep2(data)`, `submitStep2()`

## Out of scope
- yopmail inbox polling: app does not gate registration on email OTP — registration completes immediately on Create Account, so no inbox check is needed for AC2.
- The read-only Subdomain/Location/Address fields are not driven by tests; their state is governed by the app itself.
