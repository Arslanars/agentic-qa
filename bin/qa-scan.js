#!/usr/bin/env node
// Headless CLI for the security / performance / API-test engines so they can
// run in CI without the UI. Exits non-zero when a gate fails (a critical/high
// security finding, an over-budget perf metric, or a failing API assertion),
// which lets you wire these straight into a pipeline step.
//
//   node bin/qa-scan.js security <url> [--files] [--zap] [--no-active]
//   node bin/qa-scan.js perf <url>
//   node bin/qa-scan.js api <suite-file.json>
//
// Security exit code: 1 if any critical/high finding, else 0.
// Perf exit code:     1 if any metric exceeds budget, else 0.
// API exit code:      1 if any request assertion fails, else 0.

const path = require('path');

const ROOT = process.cwd();
const onLog = (m) => console.log(m);

async function main() {
  const [mode, arg, ...rest] = process.argv.slice(2);
  const flags = new Set(rest);

  if (mode === 'security') {
    if (!arg) return fail('usage: qa-scan security <url> [--files] [--zap] [--no-active] [--no-passive]');
    const { runSecurityScan } = require('../lib/security');
    const result = await runSecurityScan(arg, {
      passive: !flags.has('--no-passive'),
      active: !flags.has('--no-active'),
      probeFiles: flags.has('--files'),
      zap: flags.has('--zap'),
      reportsDir: path.join(ROOT, 'reports'),
      startedAt: new Date().toISOString(),
      onLog,
    });
    console.log(`\nRisk grade ${result.score.grade} (score ${result.score.score}/100) — ${result.findings.length} finding(s)`);
    const gate = result.score.counts.critical + result.score.counts.high;
    if (gate > 0) { console.error(`\n✗ ${gate} critical/high finding(s) — failing.`); process.exitCode = 1; return; }
    console.log('\n✓ No critical/high findings.');
    return;
  }

  if (mode === 'perf') {
    if (!arg) return fail('usage: qa-scan perf <url>');
    const { runPerf } = require('../lib/perf/lighthouse');
    const result = await runPerf(arg, { rootDir: ROOT, startedAt: new Date().toISOString(), onLog });
    if (!result.passed) { console.error('\n✗ Performance budget exceeded.'); process.exitCode = 1; return; }
    console.log('\n✓ Performance within budget.');
    return;
  }

  if (mode === 'api') {
    if (!arg) return fail('usage: qa-scan api <suite-file.json>');
    const { loadSuite, runSuite } = require('../lib/api-testing/runner');
    const suite = loadSuite(ROOT, path.basename(arg));
    const summary = await runSuite(suite, { onLog, now: () => Date.now() });
    console.log(`\n${summary.passed}/${summary.total} request(s) passed`);
    if (summary.failed > 0) { console.error(`\n✗ ${summary.failed} request(s) failed.`); process.exitCode = 1; return; }
    console.log('\n✓ All API assertions passed.');
    return;
  }

  fail('usage: qa-scan <security|perf|api> <target>');
}

function fail(msg) { console.error(msg); process.exit(2); }

main().catch((err) => { console.error('Error:', err && err.message || err); process.exit(2); });
