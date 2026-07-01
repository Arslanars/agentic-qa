# Test Plan: DashBoard-002 — Verify Dashboard with tab

## Application
- URL: https://moontower.aiimone.com/login
- Title: "MoonTower - Restaurant Inventory Management"
- Flow under test (4 steps — extends **DashBoard-001** by one tab interaction):
  1. **Login** — Email + Password + Sign In (reuses the `login-user` feature's `LoginPage`).
  2. **Location picker** (`/select-location`) — heading **"Select Your Location"**, a subtitle, and a single **"Main Location"** button for the provided account.
  3. **Dashboard** (`/inventory-vendors`) — the inventory-vendors view the app routes to after a location is chosen.
  4. **Inventory tab** — the dashboard renders a left **sidebar nav** of `<button>` items (Dashboard, **Inventory**, Quick Inventory, Vendors, Orders, …). AC4 clicks the **"Inventory"** tab.

## Relationship to DashBoard-001 (reuse, not duplication)
DashBoard-002 is **DashBoard-001 + AC4**. AC1–AC3 are identical to the `verify-dashboard` feature, so this story:
- **Reuses** `pages/login-user/LoginPage.ts` (login) and `pages/verify-dashboard/LocationPickerPage.ts` (picker) **unchanged**.
- **Extends** the existing `pages/verify-dashboard/DashboardPage.ts` (single source of truth for the dashboard) with an `inventoryTab` locator + `openInventoryTab()` action — **no second DashboardPage** is created (framework Rule 2/3/9).
- The new `verify-dashboard-with-tab` feature is self-contained (one scenario per AC, login as a shared Background) — mirroring how `verify-dashboard` already re-tests the login AC1 by reusing the `LoginPage`. The AC1–AC3 overlap with DashBoard-001 is the deliberate precondition chain for AC4.

## Acceptance Criteria → Scenario mapping

| AC | Scenario (in `features/verify-dashboard-with-tab/verify-dashboard-with-tab.feature`) | What it asserts |
|----|----------------------------------------------------------------------------------------|-----------------|
| AC1: Visit the website and log in with the given credentials | `AC1-POS-01` | After submitting the provided credentials, the app leaves `/login` and lands on `/select-location`. |
| AC2: After login you can see the "Select Your Location" text | `AC2-POS-01` | The **"Select Your Location"** heading is visible after login. |
| AC3: Click "Main Location" → URL is `https://moontower.aiimone.com/inventory-vendors` | `AC3-POS-01` | After clicking **"Main Location"**, the URL is exactly `https://moontower.aiimone.com/inventory-vendors`. |
| AC4: Click on inventory tab | `AC4-POS-01` | After clicking the **"Inventory"** sidebar tab, the Inventory view is active: the **"Inventory" heading** is visible, the URL stays `…/inventory-vendors`, and the Inventory tab carries the **active styling**. |

> One scenario per AC (framework Rule 8). Login is the shared **Background** precondition so AC2/AC3/AC4 don't re-state the AC1 steps.

## Test data
- `MOONTOWER_LOGIN_EMAIL` env var → defaults to `developers@moontower.com`
- `MOONTOWER_LOGIN_PASSWORD` env var → defaults to `12345678`

These are the **established** Moontower test credentials already used by the `login-user` and `verify-dashboard` features (read from env with safe fallbacks in the step definitions — never hard-coded in the `.feature`). The story's CREDENTIALS field was left blank; rather than invent values, the run reuses this confirmed-working account (verified live during exploration). **All four ACs require an authenticated session**, so there is no login-free subset to run separately.

## Page Objects
- **Reused unchanged:** `pages/login-user/LoginPage.ts` (AC1 login) and `pages/verify-dashboard/LocationPickerPage.ts` (AC2/AC3 picker).
- **Extended (additive only):** `pages/verify-dashboard/DashboardPage.ts` — adds:
  - `inventoryTab` = `getByRole('button', { name: 'Inventory', exact: true })` (the sidebar tab),
  - `inventoryHeading` = `getByRole('heading', { name: 'Inventory', exact: true })` (the active-view header),
  - `openInventoryTab()` — waits for the sidebar to finish "Loading…", then clicks the tab.
  - The existing `url` + `expectLoaded()` (URL assertion) are unchanged, so DashBoard-001 keeps passing.

All extend `BasePage` and use role-based locators.

## Exploration notes (live run, 2026-06-30)
1. Login with `developers@moontower.com` redirects `/login → /select-location` (confirmed). Picker shows heading **"Select Your Location"**, subtitle "Choose which location you want to manage…", and (after "Loading locations…") the single **"Main Location"** button.
2. Clicking "Main Location" routes to **`https://moontower.aiimone.com/inventory-vendors`** (SPA client-side nav). The dashboard shows **"Loading…"** for several seconds before the chrome renders.
3. Once loaded, the dashboard exposes a **left sidebar** of `<button>` nav items: `Dashboard, Inventory, Quick Inventory, Vendors, Orders, Inventory Items, Menu Items, Inflation Tracker, Settings`. There is **no `role="tab"`/`role="tablist"`** — these are styled buttons. The "inventory tab" is the button whose exact accessible name is **"Inventory"** (`count=1`, visible).
4. `/inventory-vendors` **defaults to the Inventory sub-view** — heading "Inventory" + subtitle "Track stock levels, manage vendors, and identify ordering needs". Clicking the Inventory tab keeps the URL at `/inventory-vendors` and keeps the Inventory view active.
5. **Active-tab signal:** the app exposes **no** `aria-selected`/`aria-current`/`data-state`. The active tab is conveyed **only by CSS class** — active = `bg-[#A4D0FA] text-[#06378D]` (blue; the app was re-themed from the earlier `bg-[#DC2626]` red), inactive siblings carry no such background. AC4 therefore proves "the tab is selected" via (a) the Inventory **heading** being visible and (b) the tab's **active class**, alongside the unchanged URL.

## AC4 verification strategy (why these assertions)
AC4 ("Click on inventory tab") states no explicit post-condition, and `/inventory-vendors` already defaults to the Inventory view. To keep the test **honest** (Rule 8 — no watered-down green), AC4-POS-01 exercises the real click and then proves an observable selected-state:
- `expect(page).toHaveURL('https://moontower.aiimone.com/inventory-vendors')` — still on the dashboard route after the click.
- `expect(inventoryHeading).toBeVisible()` — the Inventory view is rendered.
- `expect(inventoryTab).toHaveClass(/bg-\[#A4D0FA\]/)` — the Inventory tab is the **active** tab (the only active-state signal the app exposes).

## Out of scope
- Negative / validation login — owned by the `login-user` feature; not duplicated (Rule 3/4).
- Multi-location selection — the provided account exposes a single location ("Main Location").
- Other sidebar tabs (Vendors, Orders, Dashboard, …) and dashboard data/content correctness — AC4 scopes verification to selecting the **Inventory** tab only.
