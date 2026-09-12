// Single source of truth for Playwright project names.
//
// Consumed by playwright.config.js (which turns these into real projects) and
// by ui/server.js (which validates run requests, builds the matrix project
// list, and serves this list to the UI's browser dropdowns). Keeping one list
// stops the UI from offering a project the config does not define — which
// would fail the run with "no such project" only after you clicked Run.
//
// `device` is a key into Playwright's `devices` registry; `name` is what gets
// passed to `--project=` and what Playwright appends to artifact directory
// names (e.g. `...-ipad-pro-11`).

const DESKTOP_PROJECTS = [
  { name: 'chromium', device: 'Desktop Chrome', label: 'chromium', kind: 'desktop' },
  { name: 'firefox', device: 'Desktop Firefox', label: 'firefox', kind: 'desktop' },
  { name: 'webkit', device: 'Desktop Safari', label: 'webkit', kind: 'desktop' },
];

// EMULATION, not a simulator. Playwright applies each preset's viewport,
// device-scale-factor, user agent and touch flags to a desktop WebKit or
// Chromium build — so these approximate mobile layout and touch behaviour,
// they do not run real iOS Safari or Android Chrome. There is no iOS
// Simulator / Android Emulator involved.
//
// No Firefox variants on purpose: Playwright rejects mobile emulation there
// with "options.isMobile is not supported in Firefox".
//
// Touch fidelity, measured on a navigated page (not about:blank — emulation
// overrides are applied on navigation, so probing about:blank reports the
// 980px legacy viewport and stale touch flags):
//   - page.tap() dispatches pointerdown > touchstart > mousedown > click on
//     BOTH engines, so touch interaction is functional everywhere.
//   - `ontouchstart`, `TouchEvent` and `(pointer: coarse)` all report true on
//     both engines.
//   - BUT `navigator.maxTouchPoints` is 0 on WebKit and 1 on Chromium. An app
//     that gates its mobile layout on `maxTouchPoints > 0` will therefore look
//     non-touch on the iPad/iPhone projects. Prefer width- or
//     `(pointer: coarse)`-based assertions over maxTouchPoints in device tests.
const DEVICE_PROJECTS = [
  { name: 'ipad-pro-11', device: 'iPad Pro 11', label: 'iPad Pro 11 — tablet', kind: 'tablet' },
  { name: 'galaxy-tab-s4', device: 'Galaxy Tab S4', label: 'Galaxy Tab S4 — tablet', kind: 'tablet' },
  { name: 'iphone-14', device: 'iPhone 14', label: 'iPhone 14 — phone', kind: 'phone' },
  { name: 'galaxy-s24', device: 'Galaxy S24', label: 'Galaxy S24 — phone', kind: 'phone' },
];

const ALL_PROJECTS = [...DESKTOP_PROJECTS, ...DEVICE_PROJECTS];

module.exports = {
  DESKTOP_PROJECTS,
  DEVICE_PROJECTS,
  ALL_PROJECTS,
  // Every runnable project name.
  projectNames: ALL_PROJECTS.map((p) => p.name),
  // The "All browsers" matrix stays desktop-only: including the four device
  // projects would more than double every matrix run against the live app.
  desktopProjectNames: DESKTOP_PROJECTS.map((p) => p.name),
};
