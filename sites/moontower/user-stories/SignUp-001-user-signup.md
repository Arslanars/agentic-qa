# User Story: SignUp-001 - User Signup

## Story Title
As a new visitor to Moontower, I want to fill in the signup form and register a new account so that I can access the platform.

## Story Description
The Moontower signup page accepts new tenant/user registration. A visitor lands on the signup screen, enters their account and business details, submits the form, and the application confirms the account was created (post-submit success state — typically redirect or confirmation screen).

## Application URL
<https://moontower.aiimone.com/signup>

## Test Credentials
- Email: `arslan.moon@yopmail.com` (disposable inbox; safe for repeated test runs)

> Tests read this from `MOONTOWER_SIGNUP_EMAIL`, falling back to the literal above.

## Acceptance Criteria

### AC1: Fill the signup form and register as a new user
- GIVEN the visitor is on `https://moontower.aiimone.com/signup`
- WHEN the visitor fills every required field with valid data and submits the form
- THEN the form submission succeeds without surface-level validation errors

### AC2: Verify the user is registered
- GIVEN AC1 just succeeded
- WHEN the post-submit state settles
- THEN the page transitions to a success state (URL change away from `/signup`, an OTP/verification screen, or an explicit success message) — confirming the server accepted the registration

## Business Rules
1. Email must be unique per tenant; tests use a disposable yopmail address that can be re-registered.
2. Required fields are discovered by exploration; the test fills every visible required field.

## Technical Notes
- Browsers: chromium (primary). Multi-step form possible — handle Next button transitions if present.
- Email-uniqueness collisions are expected on re-runs; the spec for AC1 documents this and asserts the post-submit transition rather than a literal "account created" string (which the app may not surface verbatim).
- If the success indicator is gated on an OTP that arrives via email, AC2 is documented as `test.fail` with the reason — we don't fake a green by skipping the verification.

## Definition of Done
- [ ] One spec per AC under `tests/user-signup/`
- [ ] POM `pages/user-signup/SignupPage.ts` extending `BasePage`
- [ ] Specs run cleanly on chromium and either pass (true verification) or fail loudly (no false greens)
