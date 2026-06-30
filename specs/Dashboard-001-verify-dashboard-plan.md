# Test Plan: DashBoard-001 — Verify Dashboard

## Application
- URL: https://moontower.aiimone.com/login
- Title: "MoonTower - Restaurant Inventory Management"
- Flow under test (3 screens):
  1. **Login** — Email + Password + Sign In (same screen the `login-user` feature already covers).
  2. **Location picker** (`/select-location`) — heading **"Select Your Location"**, a subtitle paragraph ("Choose which location you want to manage…"), and one or more location buttons. The provided account exposes a single button labelled **"Main Location"**.
  3. **Dashboard** (`/inventory-vendors`) — the inventory-vendors view the app routes to after a location is chosen.
- **Success state:** clicking "Main Location" navigates the SPA from `/select-location` to `https://moontower.aiimone.com/inventory-vendors`.

## Acceptance Criteria → Scenario mapping

| AC | Scenario (in `features/verify-dashboard/verify-dashboard.feature`) | What it asserts |
|----|--------------------------------------------------------------------|-----------------|
| AC1: Visit the website and log in with the given credentials | `AC1-POS-01` | After submitting the provided credentials, the app leaves `/login` and lands on the `/select-location` location-picker screen. |
| AC2: After login you can see the "Select Your Location" text | `AC2-POS-01` | The **"Select Your Location"** heading is visible on the post-login screen. |
| AC3: Click "Main Location" → dashboard URL is `https://moontower.aiimone.com/inventory-vendors` | `AC3-POS-01` | After clicking the **"Main Location"** button, the URL is exactly `https://moontower.aiimone.com/inventory-vendors`. |

> One scenario per AC (framework Rule 8). Login is the shared **Background** precondition so AC2/AC3 don't re-state the AC1 steps.

## Test data
- `MOONTOWER_LOGIN_EMAIL` env var → defaults to `developers@moontower.com`
- `MOONTOWER_LOGIN_PASSWORD` env var → defaults to `12345678`

(Same env-var convention as the `login-user` plan — credentials are read in the step definitions, never hard-coded in the `.feature` file.)

## Page Objects
- **Reused:** `pages/login-user/LoginPage.ts` — drives AC1 login. No new login POM is created (framework Rule 2/Rule 9: a `LoginPage` for this exact app already exists).
- **New:** `pages/verify-dashboard/LocationPickerPage.ts` — `/select-location` screen. Exposes `heading`, `subtitle`, `mainLocationButton`; methods `expectLoaded()`, `selectMainLocation()`.
- **New:** `pages/verify-dashboard/DashboardPage.ts` — `/inventory-vendors` dashboard. Holds the URL constant + `expectLoaded()` (single source of truth for the AC3 success URL).

All extend `BasePage` and use role-based locators (`getByRole`) — stable against minor markup changes.

## Exploration notes (live run, 2026-06-30)
1. Login with `developers@moontower.com` redirects `/login → /select-location`. Confirmed via navigation trail.
2. `/select-location` exposes exactly one heading ("Select Your Location") and exactly one button ("Main Location"). The AC's spelling "Mian Loaction" / "Main Loaction" is a typo — the real accessible name is **"Main Location"**.
3. Clicking "Main Location" routes to `https://moontower.aiimone.com/inventory-vendors` (SPA client-side navigation, ~1–2 s). The dashboard body renders asynchronously, so the **URL** is the stable success signal the AC asks for — that is what AC3 asserts.

## Out of scope
- Negative / validation login (wrong creds, empty fields, format) — already exhaustively covered by the `login-user` feature; not duplicated here (Rule 3, Rule 4).
- Multi-location selection — the provided account exposes a single location ("Main Location").
- Dashboard data/content assertions — AC3 explicitly scopes verification to the URL ("verify the URL … That's it").
