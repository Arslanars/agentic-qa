// Read what the existing suite already covers, so gaps.js can diff the crawled
// surface against it.
//
// The key insight that makes this diff meaningful: every page object in this
// repo locates by role + accessible name (page.getByRole('button', { name:
// 'Sign In' })). The crawler reports role + accessible name too. So "is this
// control tested?" reduces to "does its accessible name appear anywhere in the
// page objects, step definitions, or Gherkin?" — a real answer, not a guess.
//
// We read three layers:
//   pages/**/*.ts     — getByRole/getByLabel/getByText targets + route urls
//   features/**/*.steps.ts — the same, for steps that locate inline
//   features/**/*.feature  — scenario titles, tags, and quoted step arguments

const fs = require('fs');
const path = require('path');

// page.getByRole('button', { name: 'Sign In' })  /  { name: /show|hide/i }
const GET_BY_ROLE_RE = /getByRole\(\s*['"`]([a-z]+)['"`]\s*(?:,\s*\{[^}]*?name:\s*(?:['"`]([^'"`]*)['"`]|\/([^/]+)\/[a-z]*))?[^)]*\)/g;
// getByLabel('Email') / getByPlaceholder('Search items...') / getByText('...')
const GET_BY_TEXTISH_RE = /getBy(Label|Placeholder|Text|Title|AltText|TestId)\(\s*(?:['"`]([^'"`]*)['"`]|\/([^/]+)\/[a-z]*)/g;
const URL_FIELD_RE = /readonly\s+url\s*=\s*['"`]([^'"`]+)['"`]/g;
const GOTO_RE = /\.goto\(\s*['"`]([^'"`]+)['"`]/g;
const SCENARIO_RE = /^\s*(?:Scenario|Scenario Outline|Example):\s*(.+)$/gm;
const TAG_RE = /@[\w-]+/g;
const QUOTED_ARG_RE = /"([^"]{2,60})"/g;

function walk(dir, filterFn, out = []) {
  if (!dir || !fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filterFn, out);
    else if (filterFn(entry.name)) out.push(full);
  }
  return out;
}

function readSafe(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

/**
 * Build the coverage index.
 *
 * @returns {{
 *   roleNames: Map<string, Set<string>>,   // role -> accessible names located
 *   allNames: Set<string>,                 // every name/text the suite targets (lowercased)
 *   routes: Set<string>,                   // pathnames the suite navigates to
 *   scenarios: Array<{feature,title,tags}>,
 *   files: {pages:number, steps:number, features:number}
 * }}
 */
function readCorpus({ root, featuresDir, pagesDir } = {}) {
  const featDir = featuresDir || path.join(root, 'features');
  const pgDir = pagesDir || path.join(root, 'pages');

  const pageFiles = walk(pgDir, (n) => n.endsWith('.ts'));
  const stepFiles = walk(featDir, (n) => n.endsWith('.steps.ts'));
  const featureFiles = walk(featDir, (n) => n.endsWith('.feature') && !n.startsWith('_'));

  const roleNames = new Map();
  const allNames = new Set();
  const routes = new Set();
  const scenarios = [];

  const addName = (value) => {
    const v = String(value || '').trim();
    if (v) allNames.add(v.toLowerCase());
  };
  const addRoleName = (role, value) => {
    const v = String(value || '').trim();
    if (!role || !v) return;
    if (!roleNames.has(role)) roleNames.set(role, new Set());
    roleNames.get(role).add(v.toLowerCase());
    addName(v);
  };

  for (const file of [...pageFiles, ...stepFiles]) {
    const src = readSafe(file);

    let m;
    GET_BY_ROLE_RE.lastIndex = 0;
    while ((m = GET_BY_ROLE_RE.exec(src)) !== null) {
      const [, role, literal, regex] = m;
      // A regex name (e.g. /show password|hide password/i) covers several
      // literals — record each alternative so the diff sees them all.
      if (regex) {
        for (const alt of regex.split('|')) addRoleName(role, alt.replace(/[\\^$.*+?()[\]{}]/g, '').trim());
      } else if (literal !== undefined) {
        addRoleName(role, literal);
      } else {
        // Bare getByRole('table') with no name — record the role itself.
        if (!roleNames.has(role)) roleNames.set(role, new Set());
      }
    }

    GET_BY_TEXTISH_RE.lastIndex = 0;
    while ((m = GET_BY_TEXTISH_RE.exec(src)) !== null) {
      const literal = m[2];
      const regex = m[3];
      if (regex) for (const alt of regex.split('|')) addName(alt.replace(/[\\^$.*+?()[\]{}]/g, '').trim());
      else addName(literal);
    }

    URL_FIELD_RE.lastIndex = 0;
    while ((m = URL_FIELD_RE.exec(src)) !== null) {
      try { routes.add(new URL(m[1]).pathname.replace(/\/+$/, '') || '/'); } catch { /* not absolute */ }
    }
    GOTO_RE.lastIndex = 0;
    while ((m = GOTO_RE.exec(src)) !== null) {
      try { routes.add(new URL(m[1]).pathname.replace(/\/+$/, '') || '/'); } catch { /* relative goto */ }
    }
  }

  for (const file of featureFiles) {
    const src = readSafe(file);
    const featureName = path.basename(path.dirname(file));
    const fileTags = (src.match(TAG_RE) || []);

    let m;
    SCENARIO_RE.lastIndex = 0;
    while ((m = SCENARIO_RE.exec(src)) !== null) {
      scenarios.push({ feature: featureName, title: m[1].trim(), tags: [...new Set(fileTags)] });
    }
    // Quoted step arguments are usually the exact accessible name a scenario
    // acts on ('I click the "Sign up" link'), so they count as coverage.
    QUOTED_ARG_RE.lastIndex = 0;
    while ((m = QUOTED_ARG_RE.exec(src)) !== null) addName(m[1]);
  }

  return {
    roleNames,
    allNames,
    routes,
    scenarios,
    files: { pages: pageFiles.length, steps: stepFiles.length, features: featureFiles.length },
  };
}

// Words too generic to carry coverage on their own.
const STOPWORDS = new Set(['the', 'a', 'an', 'to', 'for', 'of', 'and', 'or', 'in', 'on', 'at', 'by', 'with']);

/** Significant lowercase word tokens of a control name. */
function tokenize(s) {
  return new Set(
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((t) => t.length > 1 && !STOPWORDS.has(t))
  );
}

// Coverage is decided on WORD TOKENS, not substrings.
//
// Substring matching kept producing false "covered", which is the worst failure
// mode for this feature — it hides the very gaps it exists to find. Two real
// examples from this repo: the step argument "order" marked "Create Orders" as
// tested (22 untested destructive controls vanished from the report), and after
// a length-ratio patch "inventory" still marked "Reset Inventory" as tested.
//
// The rule now: a control is covered only if some single thing the suite targets
// contains EVERY significant word of the control's name. So "Continue to Order"
// covers "Continue to Order →", while neither "order" nor "inventory" can cover
// "Create Orders" or "Reset Inventory".
function isCovered(corpus, role, name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return { covered: false, how: null };

  const byRole = corpus.roleNames.get(role);
  if (byRole && byRole.has(n)) return { covered: true, how: 'role+name' };
  if (corpus.allNames.has(n)) return { covered: true, how: 'name' };

  const needed = tokenize(n);
  if (!needed.size) return { covered: false, how: null };

  for (const known of corpus.allNames) {
    const have = tokenize(known);
    if (!have.size) continue;
    let all = true;
    for (const t of needed) {
      if (!have.has(t)) { all = false; break; }
    }
    if (all) return { covered: true, how: 'tokens' };
  }
  return { covered: false, how: null };
}

module.exports = { readCorpus, isCovered, walk, tokenize };
