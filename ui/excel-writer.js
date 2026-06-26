// Excel writer — generates reports/Test-Cases.xlsx using the canonical
// 10-column format (TEST CASE ID, TEST SCENARIO, TEST CASE, PRE-CONDITION,
// TEST STEPS, TEST DATA, EXPECTED RESULT, POST CONDITION, ACTUAL RESULT,
// STATUS (PASS/FAIL)).
//
// Source of truth for columns 1-8 = tests/<feature>/testcases.json (authored
// alongside the tests). Columns 9-10 are filled from the latest Playwright
// run (test-results/results.json).

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

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
  { header: 'TOTAL TESTS',   key: 'total',       width: 14 },
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
 * Discover every tests/<feature>/testcases.json the repo contains.
 */
function discoverTestcaseFiles(root) {
  const testsDir = path.join(root, 'tests');
  if (!fs.existsSync(testsDir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(testsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(testsDir, entry.name, 'testcases.json');
    if (fs.existsSync(candidate)) files.push(candidate);
  }
  return files;
}

/**
 * Walk Playwright's nested suite tree, returning a flat list of test results
 * keyed by `<file>::<test title>` so we can join to test cases.
 */
function buildResultMap(root) {
  const jsonPath = path.join(root, 'test-results', 'results.json');
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

function lookupResult(resultMap, linkedSpec, linkedTestTitle) {
  // Test the exact key first, then walk all keys for a fuzzy file-suffix match
  // since Playwright reports paths relative to testDir.
  const norm = (linkedSpec || '').replace(/\\/g, '/');
  const exact = resultMap.get(`${norm}::${linkedTestTitle}`);
  if (exact) return exact;
  for (const [key, val] of resultMap) {
    const [file, title] = key.split('::');
    if (file.endsWith(norm) && title === linkedTestTitle) return val;
  }
  return null;
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

  let passCount = 0, failCount = 0, skipCount = 0;

  for (const tc of testCases) {
    const result = lookupResult(resultMap, tc.linkedSpec, tc.linkedTestTitle);
    const badge = statusBadge(result?.status);
    let actualResult;
    if (!result) {
      actualResult = 'No run data — execute the suite to capture the actual result.';
    } else if (result.status === 'passed' || result.status === 'flaky') {
      actualResult = `Passed in ${fmtDuration(result.duration)} on ${result.project}.`;
      passCount++;
    } else if (result.status === 'skipped') {
      actualResult = 'Skipped.';
      skipCount++;
    } else {
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
    row.height = Math.max(48, (tc.testSteps?.length || 0) * 14);
    row.eachCell((cell) => styleBodyCell(cell));
    const statusCell = row.getCell('status');
    statusCell.fill = badge.fill;
    statusCell.font = { ...badge.font, name: 'Calibri', size: 10.5 };
    statusCell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  }

  return { passed: passCount, failed: failCount, skipped: skipCount, total: testCases.length };
}

function buildSummarySheet(workbook, perFeatureStats) {
  const sheet = workbook.addWorksheet('Summary', {
    properties: { defaultRowHeight: 22 },
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  sheet.columns = SUMMARY_COLUMNS.map((c) => ({ ...c }));
  styleHeaderRow(sheet);

  // Move summary to be the first sheet in the workbook for convenience.
  workbook.eachSheet((s, idx) => { /* no-op */ });

  let totalPassed = 0, totalFailed = 0, totalSkipped = 0, totalCases = 0;
  for (const stat of perFeatureStats) {
    totalPassed += stat.passed;
    totalFailed += stat.failed;
    totalSkipped += stat.skipped;
    totalCases += stat.total;
    const status = stat.failed > 0 ? 'FAIL' : (stat.passed === 0 && stat.total > 0 ? 'NOT RUN' : 'PASS');
    const badge = stat.failed > 0
      ? { label: 'FAIL', fill: FAIL_FILL, font: FAIL_FONT }
      : (stat.passed === 0 && stat.total > 0
          ? { label: 'NOT RUN', fill: NOT_RUN_FILL, font: NOT_RUN_FONT }
          : { label: 'PASS', fill: PASS_FILL, font: PASS_FONT });
    const row = sheet.addRow({
      feature: stat.feature,
      storyId: stat.storyId || '—',
      total: stat.total,
      passed: stat.passed,
      failed: stat.failed,
      skipped: stat.skipped,
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
 * Main entry — discovers all testcases.json files, joins with the latest run
 * results, writes reports/Test-Cases.xlsx. Returns metadata about what was
 * written so callers can log it.
 */
async function writeTestCasesExcel({ root, onLog } = {}) {
  const log = (msg) => { if (onLog) onLog(msg); };
  const files = discoverTestcaseFiles(root);
  if (files.length === 0) {
    log('[excel] no tests/<feature>/testcases.json files found — skipping Excel export.');
    return null;
  }

  const resultMap = buildResultMap(root);
  const lastRun = fmtLocalDateTime();
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'agentic-qa';
  workbook.created = new Date();

  // Defer summary sheet until we know the per-feature stats. ExcelJS lets us
  // add sheets in any order, but the sheet TAB order matches creation order —
  // so we'll add Summary first as a placeholder, then move stats in after.
  // Workaround: build feature sheets first (collecting stats), then create the
  // Summary sheet, then re-arrange via workbook.removeWorksheet + re-create.
  const featureStats = [];
  for (const file of files) {
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
    log(`[excel] sheet ${meta.storyId || meta.feature}: ${stats.passed} passed, ${stats.failed} failed, ${stats.skipped} skipped (${stats.total} total)`);
  }

  if (featureStats.length === 0) {
    log('[excel] nothing to write — no valid testcases.json files.');
    return null;
  }

  // Build summary AT THE END so we have totals, but make it sheet #1 by
  // creating it last then reordering via orderNo.
  buildSummarySheet(workbook, featureStats);
  // Reorder: Summary first
  const summary = workbook.getWorksheet('Summary');
  if (summary) {
    summary.orderNo = -1;
    // ExcelJS doesn't have first-class reorder; we serialize+rebuild order via
    // worksheets array. Easier: write a NEW workbook in the right order.
  }
  // Simpler: rebuild the workbook in the desired order.
  const finalWb = new ExcelJS.Workbook();
  finalWb.creator = workbook.creator;
  finalWb.created = workbook.created;
  // Summary first
  const summaryName = 'Summary';
  if (workbook.getWorksheet(summaryName)) {
    cloneSheet(workbook.getWorksheet(summaryName), finalWb);
  }
  // Then per-feature sheets in discovered order
  for (const stat of featureStats) {
    const name = (stat.storyId || stat.feature).slice(0, 31);
    const src = workbook.getWorksheet(name);
    if (src) cloneSheet(src, finalWb);
  }

  const outPath = path.join(root, 'reports', 'Test-Cases.xlsx');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await finalWb.xlsx.writeFile(outPath);
  const bytes = fs.statSync(outPath).size;
  log(`[excel] wrote reports/Test-Cases.xlsx (${(bytes / 1024).toFixed(1)} KB, ${featureStats.length} sheet${featureStats.length === 1 ? '' : 's'} + summary)`);
  return { path: 'reports/Test-Cases.xlsx', features: featureStats };
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
