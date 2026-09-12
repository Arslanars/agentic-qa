// Parse Playwright's locator.ariaSnapshot() YAML into a flat control list.
//
// ariaSnapshot() is the right primitive for this codebase because every page
// object already locates by role + accessible name (page.getByRole('button',
// { name: 'Sign In' })). So the snapshot speaks the same language the tests do,
// which is what makes the coverage diff in gaps.js meaningful rather than a
// guess at CSS selectors.
//
// Snapshot shape (verified against Playwright 1.60):
//
//   - main:
//     - heading "T" [level=1]
//     - link "Go":
//       - /url: /x
//     - button "Send 5": S
//     - textbox "Email"
//     - tab "Items"
//
// Notes on the grammar we rely on:
//  * one node per line, nesting by two-space indent
//  * role is the first token; an accessible name follows in double quotes
//  * bracketed attributes ([level=1], [cursor=pointer], [ref=e7]) trail the name
//  * a link's href arrives as a child line "- /url: <href>"
//  * a node may carry inline text after a colon (button "Send 5": S)

const NODE_RE = /^(\s*)-\s+([a-zA-Z][\w-]*)(?:\s+"((?:[^"\\]|\\.)*)")?(.*)$/;
const URL_RE = /^\s*-\s+\/url:\s*(.*)$/;
const ATTR_RE = /\[([\w-]+)=([^\]]*)\]/g;

function unescapeName(s) {
  return String(s || '').replace(/\\(["\\])/g, '$1');
}

/**
 * @param {string} snapshot raw ariaSnapshot() output
 * @returns {Array<{role,name,url,attrs,depth,text}>} in document order
 */
function parseAriaSnapshot(snapshot) {
  const out = [];
  if (!snapshot) return out;
  const lines = String(snapshot).split('\n');

  for (const line of lines) {
    if (!line.trim()) continue;

    // A "/url:" line belongs to the most recent node (the link above it).
    const urlMatch = line.match(URL_RE);
    if (urlMatch) {
      const last = out[out.length - 1];
      if (last && !last.url) last.url = urlMatch[1].trim();
      continue;
    }

    const m = line.match(NODE_RE);
    if (!m) continue;
    const [, indent, role, rawName, tail] = m;

    const attrs = {};
    let attrMatch;
    ATTR_RE.lastIndex = 0;
    while ((attrMatch = ATTR_RE.exec(tail || '')) !== null) {
      attrs[attrMatch[1]] = attrMatch[2];
    }

    // Inline text after the colon, minus any bracketed attributes.
    let text = '';
    const colonIdx = (tail || '').indexOf(':');
    if (colonIdx !== -1) {
      text = (tail || '').slice(colonIdx + 1).replace(ATTR_RE, '').trim();
    }

    out.push({
      role,
      name: unescapeName(rawName),
      url: null,
      attrs,
      depth: Math.floor(indent.length / 2),
      text,
    });
  }

  return out;
}

/** Collapse whitespace and trim so name variants do not key separately. */
function normalizeName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim();
}

/**
 * Collapse duplicates so a table with 40 identical "Expand row" buttons counts
 * as one control with count=40 rather than 40 separate findings.
 * Keyed on role + name, which is exactly how a test would target it — and a
 * count > 1 is itself a signal, since that is what breaks Playwright strict
 * mode (the getByRole('button', {name:'Inventory'}) ambiguity we already hit).
 */

function dedupeControls(nodes) {
  const map = new Map();
  for (const n of nodes) {
    // Normalise whitespace before keying: a name and the same name with a
    // trailing space keyed as two controls, which is how one route reported
    // stepper counts of [1, 1, 316, 316] instead of [316, 316].
    const name = normalizeName(n.name);
    const key = `${n.role}\u0000${name}`;
    const existing = map.get(key);
    if (existing) {
      existing.count += 1;
      if (!existing.url && n.url) existing.url = n.url;
    } else {
      map.set(key, { role: n.role, name, url: n.url, count: 1, attrs: n.attrs });
    }
  }
  return [...map.values()];
}

module.exports = { parseAriaSnapshot, dedupeControls, normalizeName };
