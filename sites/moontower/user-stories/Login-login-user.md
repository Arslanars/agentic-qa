# User Story: Login - Login User

## Story Title
As a registered Moontower user, I want to sign in with my email and password so that I can access my restaurant's dashboard.

## Story Description
The Moontower login page accepts an email + password pair and, on success, redirects the user to the `/select-location` screen where they choose which location of their restaurant to manage.

## Application URL
<https://moontower.aiimone.com/Login>

## Test Credentials
- Email: `developers@moontower.com`
- Password: `12345678`

> Tests read these from `MOONTOWER_LOGIN_EMAIL` / `MOONTOWER_LOGIN_PASSWORD`, falling back to the literals above.

## Acceptance Criteria

### AC1: Visit site and try to login
- GIVEN the user is on `https://moontower.aiimone.com/Login`
- WHEN they submit the form with valid email + password
- THEN the app authenticates the user and navigates them to `/select-location`
- AND the post-login screen shows the "Select Your Location" heading and "Restaurant: Demo Restaurant"

## Technical Notes
- Browser: chromium (primary)
- Post-login redirect is the canonical success indicator — Moontower does NOT show a literal "Welcome" toast.
- The `/select-location` route is shared with the post-signup flow (see `SignUp-001`); the per-restaurant text confirms the login routed to the correct account.

## Definition of Done
- [ ] One spec for AC1 under `tests/login-user/`
- [ ] POM `pages/login-user/LoginPage.ts` extending `BasePage`
- [ ] Spec passes on chromium with the provided credentials, or fails loudly with a precise reason
