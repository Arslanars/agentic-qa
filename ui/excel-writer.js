// Excel writer — generates one test-case workbook PER SITE using the canonical
// 10-column format (TEST CASE ID, TEST SCENARIO, TEST CASE, PRE-CONDITION,
// TEST STEPS, TEST DATA, EXPECTED RESULT, POST CONDITION, ACTUAL RESULT,
// STATUS (PASS/FAIL)).
//
//   reports/Test-Cases-moontower.xlsx      sites/moontower/**/testcases.json
//   reports/Test-Cases-saucedemo.xlsx      sites/saucedemo/**/testcases.json
//   reports/Test-Cases.xlsx                legacy top-level features/ + tests/
//
// One workbook per site rather than one merged file, because the ACTUAL RESULT
// and STATUS columns come from the LAST RUN. A merged workbook rewritten after
// running site B would reset every one of site A's rows to "not run" — the
// results wouldn't just be mixed, they'd be destroyed. Splitting by site means
// running one application only touches that application's workbook.
//
// For the same reason a site's workbook is only rewritten when that site
// actually appears in the latest run (or has no workbook yet). See
// sitesInLastRun().
//
// Source of truth for columns 1-8 = <site>/features/<feature>/testcases.json
// (authored alongside the tests). Columns 9-10 are filled from the latest
// Playwright run (test-results/results.json).

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

/**
 * Id of the implicit site backed by the top-level features/ + tests/ folders.
 * Matches ui/sites.js. Not required from there: this module is also loaded by
 * bin/ scripts that have no UI dependency, and the only thing it needs is the
 * sentinel value.
 */
const LEGACY_SITE = '@root';

/** reports/Test-Cases.xlsx for the legacy layout, Test-Cases-<site>.xlsx otherwise. */
function workbookNameFor(site) {
  return site === LEGACY_SITE ? 'Test-Cases.xlsx' : `Test-Cases-${site}.xlsx`;
}

const COLUMN_DEFS = [
  { header: 'TEST CASE ID',         key: 'id',             width: 22 },
  { header: 'TEST SCENARIO',        key: 'scenario',       width: 38 },
  { header: 'TEST CASE',            key: 'testCase',       width: 42 },
  { header: 'PRE-CONDITION',        key: 'preCondition',   width: 34 },
  { header: 'TEST STEPS',           key: 'testSteps',      width: 52 },
  { header: 'TEST DATA',            key: 'testData',       width: 38 },
  { header: 'EXPECTED RESULT',      key: 'expectedResult', width: 44 },
  { header: 'POST CONDITION',       key: 'postCondition',  width: 36 },
  { header: 'ACTUAL RESULT',        key: 'actualResult',   width: 40 },
  { header: 'STATUS (PASS/FAIL)',   key: 'status',         width: 18 },
];

const SUMMARY_COLUMNS = [
  { header: 'FEATURE',       key: 'feature',     width: 26 },
  { header: 'STORY ID',      key: 'storyId',     width: 18 },
  { header: 'TOTAL CASES',   key: 'total',       width: 14 },
  { header: 'AUTOMATED',     key: 'automated',   width: 14 },
  { header: 'MANUAL',        key: 'manual',      width: 12 },
  { header: 'PASSED',        key: 'passed',      width: 12 },
  { header: 'FAILED',        key: 'failed',      width: 12 },
  { header: 'SKIPPED',       key: 'skipped',     width: 12 },
  { header: 'LAST RUN',      key: 'lastRun',     width: 22 },
  { header: 'STATUS',        key: 'status',      width: 14 },
];

// Color palette — matches the cyan header style in the user's reference.
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2A8FB8' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11, name: 'Calibri' };
const PASS_FILL   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD4EDDA' } };
const PASS_FONT   = { color: { argb: 'FF155724' }, bold: true };
const FAIL_FILL   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8D7DA' } };
const FAIL_FONT   = { color: { argb: 'FF721C24' }, bold: true };
const SKIP_FILL   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9ECEF' } };
const SKIP_FONT   = { color: { argb: 'FF6C757D' }, bold: true };
const NOT_RUN_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } };
const NOT_RUN_FONT = { color: { argb: 'FF856404' }, bold: true };
const MANUAL_FILL  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7E5FF' } };
const MANUAL_FONT  = { color: { argb: 'FF4338CA' }, bold: true };
const BORDER = {
  top:    { style: 'thin', color: { argb: 'FFCBD5E1' } },
  bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
  left:   { style: 'thin', color: { argb: 'FFCBD5E1' } },
  right:  { style: 'thin', color: { argb: 'FFCBD5E1' } },
};

function fmtLocalDateTime() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Discover every testcases.json the repo contains. We look under
 * features/<feature>/ (BDD authoring path), sites/<site>/features/<feature>/
 * (the same, once a repo tests more than one application) AND tests/<feature>/
 * (classic POM path), so the framework supports a mixed repo. If a feature has
 * both, the features/ version wins — it's the canonical location now.
 *
 * The dedup key is the feature ID ("<site>/<feature>"), not the bare folder
 * name: two sites may each have a "login" feature and both sets of test cases
 * must reach the report.
 */
function discoverTestcaseFiles(root, paths) {
  const candidates = new Map(); // feature id → { site, file }

  function pickup(dir, site) {
    if (!dir || !fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(dir, entry.name, 'testcases.json');
      const key = site === LEGACY_SITE ? entry.name : `${site}/${entry.name}`;
      if (fs.existsSync(candidate) && !candidates.has(key)) {
        candidates.set(key, { site, file: candidate });
      }
    }
  }

  // features/ first (canonical for BDD), then each site's, then tests/.
  pickup(path.join(root, 'features'), LEGACY_SITE);
  for (const site of listSiteIds(root)) {
    pickup(path.join(root, 'sites', site, 'features'), site);
  }
  pickup(paths?.tests || path.join(root, 'tests'), LEGACY_SITE);
  return Array.from(candidates.values());
}

/** Site folders under sites/ — scaffolding (_, .) excluded. */
function listSiteIds(root) {
  try {
    return fs.readdirSync(path.join(root, 'sites'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
      .map((e) => e.name)
      .sort();
  } catch {
    return []; // no sites/ — single-site layout
  }
}

/**
 * Which site a Playwright-reported spec path belongs to. Playwright reports
 * paths relative to testDir (.features-gen), so a site spec arrives as
 * "sites/<site>/features/…" — with or without the .features-gen prefix, and
 * with either separator.
 */
function siteFromSpecPath(file) {
  const norm = (file || '').replace(/\\/g, '/');
  const m = norm.replace(/^(?:.*\/)?\.?features-gen\//, '').match(/^sites\/([^/]+)\//);
  return m ? m[1] : LEGACY_SITE;
}

/**
 * Sites represented in the latest run. Returns null when the run is unknown
 * (no results.json, or it is unreadable) — callers must treat null as "don't
 * know", never as "nothing ran", or they would skip every workbook.
 */
function sitesInLastRun(root, paths) {
  const testResultsDir = paths?.testResults || path.join(root, 'test-results');
  const jsonPath = path.join(testResultsDir, 'results.json');
  try {
    if (!fs.existsSync(jsonPath)) return null;
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const out = new Set();
    (function walk(suites) {
      for (const suite of suites || []) {
        for (const spec of suite.specs || []) out.add(siteFromSpecPath(spec.file || suite.file));
        walk(suite.suites);
      }
    })(data.suites);
    return out.size ? out : null;
  } catch {
    return null;
  }
}

/**
 * Walk Playwright's nested suite tree, returning a flat list of test results
 * keyed by `<file>::<test title>` so we can join to test cases.
 */
function buildResultMap(root, paths) {
  const testResultsDir = paths?.testResults || path.join(root, 'test-results');
  const jsonPath = path.join(testResultsDir, 'results.json');
  const map = new Map();
  if (!fs.existsSync(jsonPath)) return map;
  let data;
  try { data = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); }
  catch { return map; }

  const visit = (suite) => {
    const file = (suite.file || '').replace(/\\/g, '/');
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        const last = (test.results || []).slice(-1)[0];
        if (!last) continue;
        const key = `${file}::${spec.title}`;
        map.set(key, {
          status: last.status,
          duration: last.duration,
          project: test.projectName,
          errorMessage: last.error?.message || (last.errors && last.errors[0]?.message) || null,
        });
      }
    }
    for (const child of suite.suites || []) visit(child);
  };
  for (const suite of data.suites || []) visit(suite);
  return map;
}

/**
 * Reduce a spec path to the part that identifies the test, independent of
 * layout: drop the .features-gen/ prefix (Playwright reports paths relative to
 * testDir, so it may already be gone) and any sites/<site>/ segment.
 *
 *   .features-gen/features/login-user/login.feature.spec.js   ->  features/login-user/login.feature.spec.js
 *   sites/moontower/features/login-user/login.feature.spec.js ->  features/login-user/login.feature.spec.js
 *
 * This is what lets a testcases.json written before the per-site migration
 * keep matching its results. Without it every ACTUAL RESULT / STATUS cell
 * silently reverts to "not run" — silently, because a missing result is
 * indistinguishable from a test that never ran.
 */
function canonicalSpecPath(p) {
  return (p || '')
    .replace(/\\/g, '/')
    .replace(/^(?:.*\/)?\.?features-gen\//, '')
    .replace(/^sites\/[^/]+\//, '');
}

function lookupResult(resultMap, linkedSpec, linkedTestTitle) {
  // Test the exact key first, then walk all keys for a path-suffix match (so
  // a testcases.json `linkedSpec: "login-user/login.spec.ts"` matches whatever
  // path Playwright records — could be `tests/login-user/...` or relative).
  const norm = (linkedSpec || '').replace(/\\/g, '/');
  if (!norm || !linkedTestTitle) return null;
  const exact = resultMap.get(`${norm}::${linkedTestTitle}`);
  if (exact) return exact;
  // Strict-ish suffix match: require a directory separator in the linkedSpec
  // and anchor at '/' to avoid false positives where one feature name is a
  // suffix of another (e.g., 'login.spec.ts' matching 'other-login.spec.ts').
  // Both sides are canonicalised so the comparison survives the layout the
  // path was written in.
  if (!norm.includes('/')) return null;
  const canonNorm = canonicalSpecPath(norm);
  const matches = [];
  for (const [key, val] of resultMap) {
    const sepIdx = key.indexOf('::');
    if (sepIdx < 0) continue;
    const file = key.slice(0, sepIdx);
    const title = key.slice(sepIdx + 2);
    if (title !== linkedTestTitle) continue;
    const canonFile = canonicalSpecPath(file);
    if (canonFile === canonNorm || canonFile.endsWith('/' + canonNorm) || canonNorm.endsWith('/' + canonFile)) {
      matches.push(val);
    }
  }
  if (matches.length === 1) return matches[0];
  return null; // 0 matches or >1 (ambiguous) → caller treats as missing.
}

function fmtSteps(steps) {
  if (Array.isArray(steps)) {
    return steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  }
  return String(steps || '');
}

function fmtDuration(ms) {
  if (!ms && ms !== 0) return '';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function statusBadge(status) {
  switch (status) {
    case 'passed':       return { label: 'PASS', fill: PASS_FILL, font: PASS_FONT };
    case 'failed':       return { label: 'FAIL', fill: FAIL_FILL, font: FAIL_FONT };
    case 'timedOut':     return { label: 'FAIL', fill: FAIL_FILL, font: FAIL_FONT };
    case 'interrupted':  return { label: 'FAIL', fill: FAIL_FILL, font: FAIL_FONT };
    case 'flaky':        return { label: 'PASS*', fill: PASS_FILL, font: PASS_FONT };
    case 'skipped':      return { label: 'SKIP', fill: SKIP_FILL, font: SKIP_FONT };
    default:             return { label: 'NOT RUN', fill: NOT_RUN_FILL, font: NOT_RUN_FONT };
  }
}

function styleHeaderRow(sheet) {
  const row = sheet.getRow(1);
  row.height = 28;
  row.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = BORDER;
  });
}

function styleBodyCell(cell) {
  cell.alignment = { vertical: 'top', horizontal: 'left', wrapText: true };
  cell.border = BORDER;
  cell.font = cell.font || { name: 'Calibri', size: 10 };
}

function buildFeatureSheet(workbook, feature, testCases, resultMap) {
  const sheetName = (feature.storyId || feature.feature).slice(0, 31); // Excel limit
  const sheet = workbook.addWorksheet(sheetName, {
    properties: { defaultRowHeight: 22 },
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  sheet.columns = COLUMN_DEFS.map((c) => ({ ...c }));
  styleHeaderRow(sheet);

  let passCount = 0, failCount = 0, skipCount = 0, manualCount = 0;

  for (const tc of testCases) {
    // Cases without a linked spec are MANUAL — they belong in the test-case
    // design doc even though no automated run produces a result for them.
    const isManual = !tc.linkedSpec || !tc.linkedTestTitle;
    const result = isManual ? null : lookupResult(resultMap, tc.linkedSpec, tc.linkedTestTitle);

    let badge;
    let actualResult;
    if (isManual) {
      badge = { label: 'MANUAL', fill: MANUAL_FILL, font: MANUAL_FONT };
      actualResult = 'Manual test case — execute per the TEST STEPS column.';
      manualCount++;
    } else if (!result) {
      badge = statusBadge();
      actualResult = 'No run data — execute the suite to capture the actual result.';
    } else if (result.status === 'passed' || result.status === 'flaky') {
      badge = statusBadge(result.status);
      actualResult = `Passed in ${fmtDuration(result.duration)} on ${result.project}.`;
      passCount++;
    } else if (result.status === 'skipped') {
      badge = statusBadge(result.status);
      actualResult = 'Skipped.';
      skipCount++;
    } else {
      badge = statusBadge(result.status);
      const firstLine = (result.errorMessage || '').split('\n')[0].slice(0, 600);
      actualResult = `Failed in ${fmtDuration(result.duration)}: ${firstLine || 'no error detail'}`;
      failCount++;
    }

    const row = sheet.addRow({
      id: tc.id,
      scenario: tc.scenario,
      testCase: tc.testCase,
      preCondition: tc.preCondition,
      testSteps: fmtSteps(tc.testSteps),
      testData: tc.testData,
      expectedResult: tc.expectedResult,
      postCondition: tc.postCondition,
      actualResult,
      status: badge.label,
    });
    // Normalize step count: testSteps may be an array (preferred) or a
    // multi-line string. Using .length on a string measures CHARACTERS, which
    // could produce row heights in the thousands and exceed Excel's ~409pt
    // ceiling, rendering as a giant blank band.
    const stepCount = Array.isArray(tc.testSteps)
      ? tc.testSteps.length
      : (String(tc.testSteps || '').split(/\r?\n/).filter(Boolean).length || 1);
    row.height = Math.min(240, Math.max(48, stepCount * 16));
    row.eachCell((cell) => styleBodyCell(cell));
    const statusCell = row.getCell('status');
    statusCell.fill = badge.fill;
    statusCell.font = { ...badge.font, name: 'Calibri', size: 10.5 };
    statusCell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  }

  return { passed: passCount, failed: failCount, skipped: skipCount, manual: manualCount, total: testCases.length };
}

function buildSummarySheet(workbook, perFeatureStats) {
  const sheet = workbook.addWorksheet('Summary', {
    properties: { defaultRowHeight: 22 },
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  sheet.columns = SUMMARY_COLUMNS.map((c) => ({ ...c }));
  styleHeaderRow(sheet);

  let totalPassed = 0, totalFailed = 0, totalSkipped = 0, totalManual = 0, totalCases = 0, totalAutomated = 0;
  for (const stat of perFeatureStats) {
    totalPassed += stat.passed;
    totalFailed += stat.failed;
    totalSkipped += stat.skipped || 0;
    totalManual += stat.manual || 0;
    totalCases += stat.total;
    const automated = stat.total - (stat.manual || 0);
    totalAutomated += automated;
    const badge = stat.failed > 0
      ? { label: 'FAIL', fill: FAIL_FILL, font: FAIL_FONT }
      : (stat.passed === 0 && (stat.skipped || 0) > 0 && (stat.skipped || 0) === automated
          ? { label: 'SKIPPED', fill: SKIP_FILL, font: SKIP_FONT }
          : (stat.passed === 0 && automated > 0
              ? { label: 'NOT RUN', fill: NOT_RUN_FILL, font: NOT_RUN_FONT }
              : (automated === 0 && stat.manual > 0
                  ? { label: 'MANUAL', fill: MANUAL_FILL, font: MANUAL_FONT }
                  : { label: 'PASS', fill: PASS_FILL, font: PASS_FONT })));
    const row = sheet.addRow({
      feature: stat.feature,
      storyId: stat.storyId || '—',
      total: stat.total,
      automated,
      manual: stat.manual || 0,
      passed: stat.passed,
      failed: stat.failed,
      skipped: stat.skipped || 0,
      lastRun: stat.lastRun,
      status: badge.label,
    });
    row.eachCell((cell) => styleBodyCell(cell));
    const statusCell = row.getCell('status');
    statusCell.fill = badge.fill;
    statusCell.font = { ...badge.font, name: 'Calibri', size: 10.5 };
    statusCell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  }

  // Totals row
  const totals = sheet.addRow({
    feature: 'TOTAL',
    storyId: '',
    total: totalCases,
    automated: totalAutomated,
    manual: totalManual,
    passed: totalPassed,
    failed: totalFailed,
    skipped: totalSkipped,
    lastRun: '',
    status: '',
  });
  totals.eachCell((cell) => {
    cell.font = { bold: true, name: 'Calibri', size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    cell.border = BORDER;
  });
}

/**
 * Build and write ONE site's workbook. Returns its stats, or null when the
 * site has no usable testcases.json.
 */
async function writeSiteWorkbook({ root, paths, site, entries, resultMap, lastRun, log }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'agentic-qa';
  workbook.created = new Date();

  // We need Summary as sheet #1, but Summary depends on the totals we collect
  // while building per-feature sheets. ExcelJS doesn't expose a clean reorder
  // API, so the pattern is: build per-feature sheets in a scratch workbook,
  // build Summary at the end, then clone everything into a final workbook
  // in the desired tab order (Summary first, then features).
  const featureStats = [];
  for (const { file } of entries) {
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      log(`[excel] could not parse ${path.relative(root, file)}: ${err.message}`);
      continue;
    }
    if (!Array.isArray(meta.testCases) || meta.testCases.length === 0) {
      log(`[excel] ${path.relative(root, file)} has no testCases array — skipped.`);
      continue;
    }
    const stats = buildFeatureSheet(workbook, meta, meta.testCases, resultMap);
    featureStats.push({
      feature: meta.feature,
      storyId: meta.storyId,
      ...stats,
      lastRun: stats.passed + stats.failed + stats.skipped > 0 ? lastRun : 'never',
    });
    log(`[excel] ${site} / ${meta.storyId || meta.feature}: ${stats.passed} passed, ${stats.failed} failed, ${stats.skipped} skipped (${stats.total} total)`);
  }

  if (featureStats.length === 0) return null;

  // Build Summary with the collected stats, then rebuild the workbook with
  // Summary as sheet #1 (sheets land in tabs in creation order).
  buildSummarySheet(workbook, featureStats);

  const finalWb = new ExcelJS.Workbook();
  finalWb.creator = workbook.creator;
  finalWb.created = workbook.created;
  cloneSheet(workbook.getWorksheet('Summary'), finalWb);
  for (const stat of featureStats) {
    const name = (stat.storyId || stat.feature).slice(0, 31);
    const src = workbook.getWorksheet(name);
    if (src) cloneSheet(src, finalWb);
  }

  const reportsDir = paths?.reports || path.join(root, 'reports');
  const outPath = path.join(reportsDir, workbookNameFor(site));
  fs.mkdirSync(reportsDir, { recursive: true });
  await finalWb.xlsx.writeFile(outPath);
  const bytes = fs.statSync(outPath).size;
  const relPath = path.relative(root, outPath).split(path.sep).join('/');
  log(`[excel] wrote ${relPath} (${(bytes / 1024).toFixed(1)} KB, ${featureStats.length} sheet${featureStats.length === 1 ? '' : 's'} + summary)`);
  return { site, path: relPath, file: path.basename(outPath), features: featureStats };
}

/**
 * Main entry — discovers every testcases.json, groups it by the site that owns
 * it, joins with the latest run results and writes ONE workbook per site.
 *
 * A site's workbook is rewritten only when that site took part in the latest
 * run, or when it has no workbook yet. Rewriting an untouched site would blank
 * its ACTUAL RESULT / STATUS columns, because those come from the current
 * results.json — which after a single-site run contains nothing for any other
 * site. Skipping leaves that site's last real results on disk.
 *
 * Returns { files: [...], path, features } — `path` and `features` describe
 * the first workbook written, so older single-site callers keep working.
 */
async function writeTestCasesExcel({ root, paths, onLog } = {}) {
  const log = (msg) => { if (onLog) onLog(msg); };
  const discovered = discoverTestcaseFiles(root, paths);
  if (discovered.length === 0) {
    log('[excel] no <site>/features/<feature>/testcases.json files found — skipping Excel export.');
    return null;
  }

  const bySite = new Map();
  for (const entry of discovered) {
    if (!bySite.has(entry.site)) bySite.set(entry.site, []);
    bySite.get(entry.site).push(entry);
  }

  const resultMap = buildResultMap(root, paths);
  const lastRun = fmtLocalDateTime();
  const ranSites = sitesInLastRun(root, paths); // null === unknown
  const reportsDir = paths?.reports || path.join(root, 'reports');

  const written = [];
  const skipped = [];
  for (const [site, entries] of bySite) {
    const exists = fs.existsSync(path.join(reportsDir, workbookNameFor(site)));
    // null (unknown run) means write everything — better a refreshed workbook
    // than a stale one when we cannot tell what ran.
    if (ranSites && !ranSites.has(site) && exists) {
      skipped.push(site);
      continue;
    }
    const result = await writeSiteWorkbook({ root, paths, site, entries, resultMap, lastRun, log });
    if (result) written.push(result);
  }

  if (skipped.length) {
    log(`[excel] left ${skipped.map(workbookNameFor).join(', ')} untouched — ${skipped.length === 1 ? 'that site' : 'those sites'} did not run, so ${skipped.length === 1 ? 'its' : 'their'} last results are preserved.`);
  }
  if (written.length === 0) {
    log('[excel] nothing to write — no valid testcases.json files.');
    return null;
  }
  return { files: written, path: written[0].path, features: written[0].features };
}

/**
 * Clone a worksheet (cells + styles + column widths) into the target workbook.
 * ExcelJS doesn't ship a built-in cross-workbook copy, so we walk the cells.
 */
function cloneSheet(src, targetWb) {
  const dst = targetWb.addWorksheet(src.name, {
    properties: src.properties,
    views: src.views,
  });
  dst.columns = src.columns.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  src.eachRow({ includeEmpty: false }, (row, rowNum) => {
    const newRow = dst.getRow(rowNum);
    newRow.height = row.height;
    row.eachCell({ includeEmpty: false }, (cell, colNum) => {
      const target = newRow.getCell(colNum);
      target.value = cell.value;
      if (cell.fill) target.fill = cell.fill;
      if (cell.font) target.font = cell.font;
      if (cell.alignment) target.alignment = cell.alignment;
      if (cell.border) target.border = cell.border;
    });
    newRow.commit();
  });
}

module.exports = { writeTestCasesExcel };
