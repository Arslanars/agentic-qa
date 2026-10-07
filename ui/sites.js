// Multi-site layout — the single source of truth for "where does this site's
// code live?". Both ui/server.js and the CLI resolve paths through here so the
// two can never drift, the same way ui/projects.js owns the browser list.
//
// ---------------------------------------------------------------------------
// LAYOUT
// ---------------------------------------------------------------------------
// Each application under test gets one self-contained folder. Adding a second
// or third site never touches the first:
//
//   sites/
//     moontower/
//       site.json                       <- name, baseUrl, credential env vars
//       features/<feature>/*.feature|.steps.ts|testcases.json
//       pages/<feature>/*.ts
//       user-stories/<ID>-<slug>.md
//     acme-shop/
//       site.json
//       features/...
//       pages/...
//       user-stories/...
//
// The relative depth from a steps file to its page objects is IDENTICAL to the
// legacy layout — `../../pages/<feature>/X` resolves correctly in both — so a
// feature folder can be moved into a site with no import rewrites. Only
// pages/BasePage.ts stays at the repo root: it is framework infrastructure
// shared by every site, not site content.
//
// ---------------------------------------------------------------------------
// LEGACY LAYOUT
// ---------------------------------------------------------------------------
// The original single-site layout (top-level `features/` + `pages/`) is still
// fully supported and is treated as one implicit site whose id is LEGACY_SITE.
// That is what makes this change additive: an existing project keeps working
// untouched, and sites are opt-in.
//
// ---------------------------------------------------------------------------
// FEATURE IDs
// ---------------------------------------------------------------------------
// A feature is addressed by a single string so every existing HTTP endpoint
// keeps its current shape:
//
//   "login-user"             -> legacy top-level features/login-user/
//   "moontower/login-user"   -> sites/moontower/features/login-user/
//
// bddgen mirrors the source path into .features-gen/, which is what lets the
// runner select a whole site by path prefix (see genDirFor / genDirForSite).

const fs = require('fs');
const path = require('path');

/** Folder holding every site. */
const SITES_DIR = 'sites';

/**
 * Id of the implicit site backed by the top-level features/ + pages/ folders.
 * Deliberately not a legal folder name (see SAFE_SEGMENT_RE) so it can never
 * collide with a real site directory.
 */
const LEGACY_SITE = '@root';

/**
 * Site and feature folder names both land in argv for a spawned Playwright
 * process, and we spawn with shell:true on Windows (cmd.exe re-parses argv).
 * Keep the character set tight enough that nothing can be interpreted as a
 * separator, a redirect, or a path traversal.
 */
const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

function isSafeSegment(s) {
  return (
    typeof s === 'string' &&
    s.length > 0 &&
    s.length <= 64 &&
    SAFE_SEGMENT_RE.test(s) &&
    s !== '.' &&
    s !== '..'
  );
}

/** Underscore-prefixed folders are scaffolding (_shared, _TEMPLATE), not sites. */
function isScaffolding(name) {
  return name.startsWith('_') || name.startsWith('.');
}

/** Turn free text (a site name, a URL host) into a safe folder segment. */
function slugify(input) {
  return (
    String(input || '')
      .toLowerCase()
      .trim()
      .replace(/^https?:\/\//, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'site'
  );
}

/** Host labels that name a deployment, not the product. */
const DEPLOYMENT_LABELS = /^(www|app|web|staging|stage|dev|test|testing|qa|uat|preprod|prod|portal|admin|api|secure|my)$/i;
/** Labels that are part of a public suffix rather than a name. */
const SUFFIX_LABELS = /^(com|net|org|gov|edu|ac|co|io|dev|app|ai|uk|us|au|ca|de|fr|in|pk)$/i;

/**
 * Derive a default site id from a URL — the first host label that names the
 * product rather than the deployment or the suffix:
 *
 *   https://moontower.aiimone.com     -> "moontower"
 *   https://www.acme.co.uk/login      -> "acme"
 *   https://staging.shop.example.com  -> "shop"
 *   https://acme.com                  -> "acme"
 *
 * This is only a DEFAULT: the caller can always pass an explicit site id, and
 * the UI shows the derived folder before anything is written.
 */
function siteIdFromUrl(url) {
  let host;
  try {
    host = new URL(String(url)).hostname;
  } catch (_) {
    return slugify(url);
  }
  const parts = host.split('.').filter(Boolean);
  // An IP address has no product name in it — keep the whole host.
  if (/^\d+$/.test(parts[parts.length - 1] || '')) return slugify(host);
  const named = parts.find((p) => !DEPLOYMENT_LABELS.test(p) && !SUFFIX_LABELS.test(p));
  return slugify(named || host);
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function isLegacy(site) {
  return !site || site === LEGACY_SITE;
}

/** Absolute path to a site's own root folder. */
function siteRoot(root, site) {
  return isLegacy(site) ? root : path.join(root, SITES_DIR, site);
}

/** Absolute path to the folder holding a site's feature folders. */
function featuresRoot(root, site) {
  return isLegacy(site) ? path.join(root, 'features') : path.join(root, SITES_DIR, site, 'features');
}

/** Absolute path to the folder holding a site's page-object folders. */
function pagesRoot(root, site) {
  return isLegacy(site) ? path.join(root, 'pages') : path.join(root, SITES_DIR, site, 'pages');
}

/** Absolute path to a site's user-stories folder. */
function storiesRoot(root, site) {
  return isLegacy(site) ? path.join(root, 'user-stories') : path.join(root, SITES_DIR, site, 'user-stories');
}

/**
 * Repo-relative POSIX path of a site's feature folder — used in prompts and
 * log lines, where forward slashes read correctly on every platform.
 */
function relFeaturesRoot(site) {
  return isLegacy(site) ? 'features' : `${SITES_DIR}/${site}/features`;
}

function relPagesRoot(site) {
  return isLegacy(site) ? 'pages' : `${SITES_DIR}/${site}/pages`;
}

function relStoriesRoot(site) {
  return isLegacy(site) ? 'user-stories' : `${SITES_DIR}/${site}/user-stories`;
}

/**
 * The .features-gen path for one feature. bddgen mirrors the source tree, so
 * this is simply `.features-gen/` + the source-relative feature folder.
 */
function genDirFor(site, feature) {
  return `.features-gen/${relFeaturesRoot(site)}/${feature}/`;
}

/** The .features-gen path covering EVERY feature of one site. */
function genDirForSite(site) {
  return `.features-gen/${relFeaturesRoot(site)}/`;
}

// ---------------------------------------------------------------------------
// Feature ids  ("<site>/<feature>"  |  "<feature>")
// ---------------------------------------------------------------------------

/**
 * Split a feature id into its parts. Returns null when either segment is
 * unsafe, so callers can reject bad input with a single falsy check rather
 * than remembering to validate twice.
 */
function parseFeatureId(id) {
  if (typeof id !== 'string' || !id) return null;
  const parts = id.split('/').filter((p) => p !== '');
  if (parts.length === 1) {
    if (!isSafeSegment(parts[0])) return null;
    return { site: LEGACY_SITE, feature: parts[0], id: parts[0] };
  }
  if (parts.length === 2) {
    if (!isSafeSegment(parts[0]) || !isSafeSegment(parts[1])) return null;
    return { site: parts[0], feature: parts[1], id: `${parts[0]}/${parts[1]}` };
  }
  return null; // 3+ segments is never valid — refuse rather than guess
}

function formatFeatureId(site, feature) {
  return isLegacy(site) ? feature : `${site}/${feature}`;
}

/**
 * Resolve a feature id to every path a caller might need. Returns null for an
 * invalid id. Does NOT check existence — callers that care use `exists`.
 */
/**
 * A bare feature id ("login-user") saved BEFORE the multi-site migration — in
 * a schedule, a bookmark, a script — used to mean features/login-user/. After
 * the migration that folder is gone, and the id would resolve to a path that
 * does not exist: Playwright is handed the missing directory and runs zero
 * tests, reporting success-ish nothing rather than an error. A saved schedule
 * would quietly stop testing anything.
 *
 * So when a bare id has no legacy folder and EXACTLY ONE site owns a feature
 * of that name, resolve to that site. Exactly one, never a guess between two:
 * with an ambiguous name we leave it unresolved so the caller 404s honestly
 * instead of silently running the wrong application's tests.
 */
function resolveLegacyAlias(root, feature) {
  const owners = listSiteIds(root).filter((s) =>
    fs.existsSync(path.join(featuresRoot(root, s), feature))
  );
  return owners.length === 1 ? owners[0] : null;
}

function resolveFeature(root, id) {
  const parsed = parseFeatureId(id);
  if (!parsed) return null;
  let { site, feature } = parsed;
  if (isLegacy(site) && !fs.existsSync(path.join(featuresRoot(root, site), feature))) {
    const alias = resolveLegacyAlias(root, feature);
    if (alias) site = alias;
  }
  const featureDir = path.join(featuresRoot(root, site), feature);
  const pagesDir = path.join(pagesRoot(root, site), feature);
  return {
    id: parsed.id,
    site,
    feature,
    isLegacy: isLegacy(site),
    featureDir,
    pagesDir,
    storiesDir: storiesRoot(root, site),
    stepsRoot: featuresRoot(root, site),
    relFeatureDir: `${relFeaturesRoot(site)}/${feature}`,
    relPagesDir: `${relPagesRoot(site)}/${feature}`,
    genDir: genDirFor(site, feature),
    exists: fs.existsSync(featureDir),
    /** Human label for the UI: "moontower › login-user". */
    label: isLegacy(site) ? feature : `${site} › ${feature}`,
  };
}

// ---------------------------------------------------------------------------
// site.json
// ---------------------------------------------------------------------------

function siteMetaPath(root, site) {
  return path.join(siteRoot(root, site), 'site.json');
}

/**
 * Read a site's metadata. Always returns an object — a site folder with a
 * missing or corrupt site.json still lists and still runs, it just shows
 * defaults. Losing the runner because one JSON file got mangled would be a
 * far worse failure than showing a placeholder name.
 */
function readSiteMeta(root, site) {
  const fallback = {
    id: site,
    name: isLegacy(site) ? 'Default (legacy layout)' : site,
    baseUrl: '',
    credentialsEnv: {},
  };
  try {
    const raw = fs.readFileSync(siteMetaPath(root, site), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return fallback;
    return {
      ...fallback,
      ...parsed,
      id: site, // the folder name is authoritative, never the file's own claim
    };
  } catch (_) {
    return fallback;
  }
}

function writeSiteMeta(root, site, meta) {
  const dir = siteRoot(root, site);
  fs.mkdirSync(dir, { recursive: true });
  const body = { ...readSiteMeta(root, site), ...meta, id: site };
  // Write-then-rename so a crash mid-write cannot leave a truncated file that
  // would read back as a corrupt site.
  const target = siteMetaPath(root, site);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, target);
  return body;
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/** Feature folder names under one site (folders containing a .feature file). */
function listFeatures(root, site) {
  const dir = featuresRoot(root, site);
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  return names
    .filter((e) => e.isDirectory() && !isScaffolding(e.name) && isSafeSegment(e.name))
    .map((e) => e.name)
    .filter((name) => {
      try {
        return fs.readdirSync(path.join(dir, name)).some((f) => f.endsWith('.feature'));
      } catch (_) {
        return false;
      }
    })
    .sort();
}

/** Site folder ids under sites/ — does NOT include the legacy site. */
function listSiteIds(root) {
  try {
    return fs
      .readdirSync(path.join(root, SITES_DIR), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !isScaffolding(e.name) && isSafeSegment(e.name))
      .map((e) => e.name)
      .sort();
  } catch (_) {
    return [];
  }
}

/**
 * Every site, each with its metadata and feature list. The legacy site is
 * included only when it actually has features, so a project that has fully
 * migrated to sites/ does not show a permanent empty "Default" row.
 */
function listSites(root) {
  const out = [];
  const legacyFeatures = listFeatures(root, LEGACY_SITE);
  if (legacyFeatures.length > 0) {
    out.push({
      ...readSiteMeta(root, LEGACY_SITE),
      id: LEGACY_SITE,
      isLegacy: true,
      features: legacyFeatures,
      featureCount: legacyFeatures.length,
    });
  }
  for (const id of listSiteIds(root)) {
    const features = listFeatures(root, id);
    out.push({
      ...readSiteMeta(root, id),
      id,
      isLegacy: false,
      features,
      featureCount: features.length,
    });
  }
  return out;
}

/**
 * Create a new site folder with its full skeleton. Idempotent: calling it for
 * an existing site refreshes site.json and leaves any existing work alone.
 */
function createSite(root, { id, name, baseUrl, credentialsEnv } = {}) {
  const siteId = isSafeSegment(id) ? id : siteIdFromUrl(baseUrl || name || '');
  if (!isSafeSegment(siteId)) throw new Error(`could not derive a safe site id from "${baseUrl || name}"`);
  const base = siteRoot(root, siteId);
  for (const sub of ['features', 'pages', 'user-stories']) {
    fs.mkdirSync(path.join(base, sub), { recursive: true });
  }
  const meta = writeSiteMeta(root, siteId, {
    name: name || siteId,
    baseUrl: baseUrl || '',
    credentialsEnv: credentialsEnv || {},
    createdAt: readSiteMeta(root, siteId).createdAt || new Date().toISOString(),
  });
  return { ...meta, id: siteId, isLegacy: false, features: listFeatures(root, siteId) };
}

module.exports = {
  SITES_DIR,
  LEGACY_SITE,
  isSafeSegment,
  slugify,
  siteIdFromUrl,
  isLegacy,
  siteRoot,
  featuresRoot,
  pagesRoot,
  storiesRoot,
  relFeaturesRoot,
  relPagesRoot,
  relStoriesRoot,
  genDirFor,
  genDirForSite,
  parseFeatureId,
  formatFeatureId,
  resolveFeature,
  readSiteMeta,
  writeSiteMeta,
  listFeatures,
  listSiteIds,
  listSites,
  createSite,
};
