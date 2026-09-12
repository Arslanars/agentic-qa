# Test Plan: Order-01 — Order Flow

## Application
- URL: https://moontower.aiimone.com/login
- Title: "MoonTower - Restaurant Inventory Management"
- Credentials (provided in the story): `testing@yopmail.com` / `12345678`
  - **Different account** from the `login-user`/`verify-dashboard` features (`developers@moontower.com`). The order-flow steps read `MOONTOWER_ORDER_EMAIL`/`MOONTOWER_ORDER_PASSWORD` from env, defaulting to the provided `testing@yopmail.com` account.

## Flow under test (single end-to-end order-send journey)
Login → location picker → dashboard → **tablet POS ordering wizard** → send all vendor orders → post-send vendor edit/cancel → exit tablet → Orders List → open an order → verify a product line.

Verified live on 2026-07-16 by driving the real app (direct Playwright exploration — the MCP `setup_page` tools are incompatible with this repo's `testDir=.features-gen` config).

## ⚠️ This is a DESTRUCTIVE flow
"Send N orders" submits **real vendor orders** (they appear permanently in `/order-history` as *Submitted*). Per `features/README.md`, destructive scenarios must be gated. The scenario is tagged **`@destructive`** so the default `npm test` (`--grep-invert=@destructive`) skips it; it runs only on explicit request (`npm run test:destructive` or `--grep @order-flow`). It is also tagged `@order-flow` for step-scoping and selective runs.

## Acceptance Criteria → single scenario (`ORDER-01`)
The story is one linear journey with two `Then` checkpoints. It maps to **one** Gherkin scenario whose steps mirror the AC verbatim (dynamic counts matched by regex in the step layer, so `(160)` / `5` staying current is not required):

| # | AC step | How it's driven / asserted | Determinism |
|---|---------|----------------------------|-------------|
| 1 | On the Moontower login page | `LoginPage.goto()` (reused) | ✅ |
| 2 | Sign in `testing@yopmail.com` / `12345678` | `LoginPage.login()` (reused) | ✅ |
| 3 | **Then** redirected to location-picker | `expect URL /select-location` | ✅ |
| 4 | Select "Main Location" | `LocationPickerPage.selectMainLocation()` (reused) → `/inventory-vendors` | ✅ |
| 5 | Click "Quick Inventory" | sidebar nav → `/quick-inventory` | ✅ |
| 6 | Click "Inventory" | sidebar nav → `/inventory-vendors` | ✅ |
| 7 | Enable tablet view | click the **"Tablet Preview"** pill; confirmed by **"Exit tablet"** appearing | ✅ |
| 8 | Click "Orders" | tablet top-bar **Orders** tab | ✅ |
| 9 | Click "Continue to Vendors → (160)" | button matched by `/Continue to Vendors/` (count ignored) | ✅ |
| 10 | Click "Review All Orders →" | button `/Review All Orders/` → heading "Review order before sending" | ✅ |
| 11 | Click "Send 5 orders" | button `/Send \d+ orders?/` (submits real orders) | ✅ |
| 12 | **Then** confirmation "Sent 5 orders across 5" | **see discrepancy #1** — assert the app's real confirmation: N vendors show **"Sent ✓"** | ⚠️ |
| 13 | Toggle "GORDON" vendor | click the GORDON vendor → opens its editor (heading "GORDON", Cancel/Save) | ✅ |
| 14 | Click "Cancel" | closes the GORDON editor | ✅ |
| 15 | Exit tablet view | "Exit tablet" → normal dashboard | ✅ |
| 16 | Click "Orders" | sidebar **Orders** group expands (Draft Order / Orders List / Invoice Log) | ✅ |
| 17 | Click "Orders List" | → `/order-history`, heading "Orders List" | ✅ |
| 18 | View order number 2 | click the 2nd row's **View** → `/order-history/<id>` | ✅ (row opens) |
| 19 | **Then** see "Sprite" in order details | assert `getByText(/Sprite/)` in the detail | ❌ **see discrepancy #2** |

## Discrepancies found during exploration (honest reporting — framework Rule 5 & 8)

### Discrepancy #1 — the literal confirmation toast does not appear
Across **3** live sends, the exact string **"Sent 5 orders across 5"** was never observable (tight body-text polling + `role=status/alert` + toast-class scans all empty). The app's genuine, observable confirmation of a successful multi-vendor send is: **each of the 5 vendor rows flips to "Sent ✓"** and **5 new "Submitted" orders** appear in `/order-history`.
- **Decision:** the step `Then I should see the confirmation message {string}` parses the vendor count `N` from the message and asserts **N vendors show "Sent ✓"** — the app's real confirmation, which directly proves *"N orders across N vendors"*. It also opportunistically checks for the literal text (non-fatal) so a future app version that adds the toast is still caught. This is **not** a watered-down green: it asserts the true success state.

### Discrepancy #2 — "Sprite" is not in order #2
- Order **#2 = the US FOODS order** (14 items) in both observed runs — it contains **no "Sprite"**.
- **"Sprite"** (a "Sprite Syrup 5:1 bag-in-box" line) is in the **SYSCO order**.
- A freshly-sent batch's **list row order is non-deterministic** (all 5 orders submit within the same minute; SYSCO appeared at row 3 in one run and row 4 in another). So *"order number 2 → Sprite"* is at best **flaky** (~1/5 chance) and in practice **fails**.
- **Decision (Rule 5 — don't guess values that change assertions; Rule 8 — no false green):** the scenario follows the AC **verbatim** (open order #2, assert "Sprite"). The step raises an **honest failure** whose message reports the actual vendor of order #2 and notes that "Sprite" lives in the SYSCO order. **Recommended AC fix:** change to *"view the SYSCO order"* / *"the order containing Sprite"* for a deterministic, meaningful assertion.

## Page Objects
- **Reused unchanged:** `pages/login-user/LoginPage.ts` (login), `pages/verify-dashboard/LocationPickerPage.ts` (Main Location).
- **New (this feature):**
  - `pages/order-flow/InventoryVendorsPage.ts` — dashboard shell: sidebar nav (Quick Inventory / Inventory / Orders group / Orders List) + tablet enable/exit.
  - `pages/order-flow/TabletOrderPage.ts` — tablet ordering wizard: Orders tab, Continue to Vendors, Review All Orders, Send N orders, "Sent ✓" confirmation, GORDON vendor toggle, Cancel.
  - `pages/order-flow/OrdersListPage.ts` — `/order-history`: view order N, assert product text in details.

All extend `BasePage`, expose `readonly Locator`s + intent methods, and keep `expect()` in the step layer (POM exception: `expectLoaded`/`expectOrdersSent`/`expectProductInDetails` helpers, matching the existing POMs' pattern).

## Test data
- `MOONTOWER_ORDER_EMAIL` → default `testing@yopmail.com`
- `MOONTOWER_ORDER_PASSWORD` → default `12345678`
- Credentials read from env with safe fallbacks in the step file — never hard-coded in the `.feature`.

## Out of scope
- Negative/validation login (owned by the `login-user` feature — not duplicated, Rule 3/4).
- The Count/Items/Drafts tablet tabs, per-item quantity editing, vendor min-order logic, CSV import — the AC exercises only the send-all-vendors happy path.
- Cross-browser matrix — this destructive scenario runs on **chromium only, `--workers=1 --retries=0`** so a retry never double-sends.
