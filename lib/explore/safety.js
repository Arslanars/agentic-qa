// Safety rules for the exploratory crawler.
//
// The crawler points at a LIVE third-party production app (Moontower). A wrong
// click here does not fail a test — it sends a real vendor order, creates a real
// account, or overwrites real inventory. So this file is the single source of
// truth for what the crawler may touch, and it is deliberately paranoid:
// anything not positively recognised as navigation is left alone.
//
// Two crawl modes:
//   'passive'  — zero clicks. Navigate only by page.goto() to same-origin URLs
//                discovered in the aria snapshot. This is the default.
//   'guarded'  — passive, plus clicks on controls that BOTH match NAV_SAFE and
//                fail every HARD_BLOCK pattern. Still never fills or submits.
//
// Nothing in either mode fills an input (beyond the one scripted login),
// submits a form, or accepts a dialog.

// Names that must never be clicked, in any mode. Matched case-insensitively
// against the control's accessible name. Ordered roughly by blast radius.
const HARD_BLOCK = [
  // Irreversible outward actions
  /\bsend\b/i,
  /\bsubmit\b/i,
  /\bplace\s+order\b/i,
  /\bcheckout\b/i,
  /\bpay\b/i,
  /\bconfirm\b/i,
  // Destructive data actions
  /\bdelete\b/i,
  /\bremove\b/i,
  /\barchive\b/i,
  /\bclear\b/i,
  /\breset\b/i,
  /\bdiscard\b/i,
  // Mutations
  /\bsave\b/i,
  /\bupdate\b/i,
  /\bcreate\b/i,
  /\badd\b/i,
  /\bedit\b/i,
  /\bset\s+pack\s+size\b/i,
  /\bupdate\s+all\s+prices\b/i,
  /\bnew\s+count\b/i,
  /\bload\s+draft\b/i,
  // Account / session
  /\bsign\s*up\b/i,
  /\bregister\b/i,
  /\bsign\s*out\b/i,
  /\blog\s*out\b/i,
  /\binvite\b/i,
  /\bchange\s+password\b/i,
  // Anything that looks like a quantity stepper — clicking these edits counts
  /^[-+±]$/,
  /\b(increment|decrement|plus|minus)\b/i,
];

// Roles that are inherently navigational and safe to activate in guarded mode.
const NAV_SAFE_ROLES = new Set(['link', 'tab']);

// Button names that are navigation in this app's shell rather than actions.
// Derived from the observed tab bar and side nav (Dashboard / Inventory /
// Settings / Tablet view, and the Count / Order / Items / Drafts / Invoice Log
// tab row). Anchored so "Order" matches but "Place Order" does not.
const NAV_SAFE_NAMES = [
  /^dashboard$/i,
  /^inventory$/i,
  /^inventory\s+items$/i,
  /^vendors$/i,
  /^settings$/i,
  // Observed in the app's side nav once past the location gate. Each is a
  // read-only list/report view. Anchored, so "Orders" is nav but "Place Order"
  // still hits the denylist. Deliberately NOT included: "Demo Restaurant" (the
  // location switcher — changes session context) and "Search" (not navigation).
  /^orders$/i,
  /^quick\s+inventory$/i,
  /^menu\s+items$/i,
  /^inflation\s+tracker$/i,
  /^tablet\s+view$/i,
  /^count$/i,
  /^order$/i,
  /^items$/i,
  /^drafts$/i,
  /^invoice\s+log$/i,
  /^order\s+history$/i,
  /^back$/i,
  /^←\s*back$/i,
  /^toggle\s+menu$/i,
  /^expand\s+row$/i,
  /^not\s+now$/i, // dismisses the "pick up your last count" notice — read-only
];

// Roles worth recording as part of the surface even though we never activate
// them. These are what a future scenario would assert on.
const INTERESTING_ROLES = new Set([
  'button', 'link', 'tab', 'textbox', 'checkbox', 'radio', 'combobox',
  'spinbutton', 'switch', 'slider', 'searchbox', 'menuitem', 'option',
  'heading', 'alert', 'status', 'dialog', 'table', 'listbox',
]);

// Roles that represent user input — the raw material for validation scenarios.
const INPUT_ROLES = new Set([
  'textbox', 'checkbox', 'radio', 'combobox', 'spinbutton',
  'switch', 'slider', 'searchbox', 'listbox', 'option',
]);

function isHardBlocked(name) {
  const n = String(name || '');
  if (!n) return false;
  return HARD_BLOCK.some((re) => re.test(n));
}

function isNavSafe(role, name) {
  const n = String(name || '').trim();
  if (isHardBlocked(n)) return false;
  if (NAV_SAFE_ROLES.has(role)) return true;
  if (role === 'button' && NAV_SAFE_NAMES.some((re) => re.test(n))) return true;
  return false;
}

/**
 * Classify one control. `clickable` is the only field the crawler acts on;
 * everything else is reporting metadata.
 */
function classifyControl(role, name, mode) {
  const blocked = isHardBlocked(name);
  const navSafe = isNavSafe(role, name);
  const isInput = INPUT_ROLES.has(role);
  let reason = null;
  let clickable = false;

  if (mode === 'passive') {
    reason = 'passive-mode-no-clicks';
  } else if (blocked) {
    reason = 'destructive-denylist';
  } else if (isInput) {
    // Never activate inputs — even a checkbox toggle is a mutation here.
    reason = 'input-control';
  } else if (navSafe) {
    clickable = true;
    reason = 'nav-safe';
  } else {
    reason = 'not-recognised-as-navigation';
  }

  return {
    clickable,
    reason,
    destructive: blocked,
    input: isInput,
    navSafe,
  };
}

/** Same-origin check that tolerates relative hrefs and ignores fragments. */
function isSameOriginUrl(href, baseUrl) {
  if (!href) return false;
  const h = String(href).trim();
  if (!h || h.startsWith('#')) return false;
  if (/^(mailto:|tel:|javascript:|data:|blob:)/i.test(h)) return false;
  try {
    const base = new URL(baseUrl);
    const resolved = new URL(h, baseUrl);
    return resolved.origin === base.origin;
  } catch {
    return false;
  }
}

/** Normalise a URL to origin+pathname so ?query and #hash do not fork routes. */
function normalizeRoute(href, baseUrl) {
  try {
    const u = new URL(String(href), baseUrl);
    let p = u.pathname.replace(/\/+$/, '');
    if (!p) p = '/';
    return p;
  } catch {
    return null;
  }
}

module.exports = {
  HARD_BLOCK,
  NAV_SAFE_NAMES,
  INTERESTING_ROLES,
  INPUT_ROLES,
  isHardBlocked,
  isNavSafe,
  classifyControl,
  isSameOriginUrl,
  normalizeRoute,
};
