// Performance budgets. Two collectors:
//
//   collectPlaywrightMetrics(url)  — default. Launches the Chromium that
//     Playwright already installed, navigates, and reads real Web Vitals
//     (FCP / LCP), navigation timing (TTFB / DOMContentLoaded / load) and
//     transfer weight from the page. No extra dependency.
//
//   runLighthouse(url)  — opt-in. Shells out to `npx lighthouse` if it's on
//     PATH for a full Lighthouse audit; gracefully reports unavailable
//     otherwise.
//
// Metrics are graded against a budget (perf/budgets.json or the defaults
// below). Each metric → pass/fail; the run passes only if every metric is
// within budget.

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const DEFAULT_BUDGET = {
  ttfbMs: 800,
  fcpMs: 2000,
  lcpMs: 2500,
  domContentLoadedMs: 3000,
  loadMs: 5000,
  transferKb: 2048,
  requests: 100,
};

function loadBudget(rootDir) {
  const p = path.join(rootDir, 'perf', 'budgets.json');
  if (fs.existsSync(p)) {
    try { return { ...DEFAULT_BUDGET, ...JSON.parse(fs.readFileSync(p, 'utf8')) }; }
    catch { /* fall through to defaults */ }
  }
  return { ...DEFAULT_BUDGET };
}

function saveBudget(rootDir, budget) {
  const dir = path.join(rootDir, 'perf');
  fs.mkdirSync(dir, { recursive: true });
  const merged = { ...DEFAULT_BUDGET, ...budget };
  fs.writeFileSync(path.join(dir, 'budgets.json'), JSON.stringify(merged, null, 2));
  return merged;
}

async function collectPlaywrightMetrics(url, { onLog = () => {}, timeoutMs = 45000 } = {}) {
  const { chromium } = require('@playwright/test');
  onLog(`[perf] launching Chromium for ${url}…`);
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  let transferBytes = 0;
  let requestCount = 0;
  page.on('response', async (res) => {
    requestCount += 1;
    try {
      const len = res.headers()['content-length'];
      if (len) transferBytes += Number(len);
    } catch (_) { /* ignore */ }
  });

  const metrics = {};
  try {
    await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
    // Give LCP a moment to settle, then read timings from the page.
    await page.waitForTimeout(1200);
    const raw = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] || {};
      const paint = performance.getEntriesByType('paint') || [];
      const fcp = paint.find((p) => p.name === 'first-contentful-paint');
      const lcpEntries = performance.getEntriesByType('largest-contentful-paint') || [];
      const lcp = lcpEntries.length ? lcpEntries[lcpEntries.length - 1] : null;
      return {
        ttfbMs: nav.responseStart || 0,
        domContentLoadedMs: nav.domContentLoadedEventEnd || 0,
        loadMs: nav.loadEventEnd || 0,
        fcpMs: fcp ? fcp.startTime : 0,
        lcpMs: lcp ? lcp.startTime : (fcp ? fcp.startTime : 0),
        transferSize: nav.transferSize || 0,
      };
    });
    Object.assign(metrics, {
      ttfbMs: Math.round(raw.ttfbMs),
      fcpMs: Math.round(raw.fcpMs),
      lcpMs: Math.round(raw.lcpMs),
      domContentLoadedMs: Math.round(raw.domContentLoadedMs),
      loadMs: Math.round(raw.loadMs),
      transferKb: Math.round((raw.transferSize || transferBytes) / 1024),
      requests: requestCount,
    });
  } finally {
    await browser.close().catch(() => {});
  }
  return metrics;
}

function gradeAgainstBudget(metrics, budget) {
  const rows = [];
  for (const key of Object.keys(budget)) {
    const limit = budget[key];
    const value = metrics[key];
    if (value == null) continue;
    const ok = value <= limit;
    rows.push({ metric: key, value, budget: limit, ok });
  }
  const passed = rows.every((r) => r.ok);
  return { passed, rows };
}

async function runPerf(url, { rootDir, onLog = () => {}, startedAt = null } = {}) {
  const budget = loadBudget(rootDir || process.cwd());
  const metrics = await collectPlaywrightMetrics(url, { onLog });
  const grade = gradeAgainstBudget(metrics, budget);
  onLog(`[perf] ${grade.passed ? 'PASS' : 'FAIL'} — ${grade.rows.filter((r) => r.ok).length}/${grade.rows.length} metrics within budget`);
  for (const r of grade.rows.filter((x) => !x.ok)) onLog(`[perf]   ✗ ${r.metric}: ${r.value} > budget ${r.budget}`);
  const result = { target: url, startedAt, metrics, budget, passed: grade.passed, rows: grade.rows };

  if (rootDir) {
    try {
      const dir = path.join(rootDir, 'reports', 'perf');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(result, null, 2));
    } catch (err) { onLog(`[perf] could not write report: ${err.message}`); }
  }
  return result;
}

// Optional full Lighthouse audit via npx. Resolves { available:false } if the
// lighthouse binary can't be resolved.
function lighthouseAvailable() {
  try { execSync('npx --no-install lighthouse --version', { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function runLighthouse(url, { onLog = () => {} } = {}) {
  return new Promise((resolve) => {
    if (!lighthouseAvailable()) {
      onLog('[perf] lighthouse not installed — using built-in Playwright metrics instead. (npm i -D lighthouse to enable)');
      return resolve({ available: false });
    }
    onLog('[perf] running full Lighthouse audit…');
    const proc = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['--no-install', 'lighthouse', url, '--output=json', '--quiet', '--chrome-flags=--headless'],
      { shell: process.platform === 'win32' });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => onLog(d.toString().replace(/\n$/, '')));
    proc.on('error', () => resolve({ available: false }));
    proc.on('close', () => {
      try {
        const json = JSON.parse(out);
        const cat = json.categories || {};
        resolve({
          available: true,
          scores: {
            performance: Math.round((cat.performance?.score || 0) * 100),
            accessibility: Math.round((cat.accessibility?.score || 0) * 100),
            'best-practices': Math.round((cat['best-practices']?.score || 0) * 100),
            seo: Math.round((cat.seo?.score || 0) * 100),
          },
        });
      } catch {
        resolve({ available: false });
      }
    });
  });
}

module.exports = { runPerf, collectPlaywrightMetrics, gradeAgainstBudget, loadBudget, saveBudget, runLighthouse, DEFAULT_BUDGET };
