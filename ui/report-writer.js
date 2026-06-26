// After every Playwright run, regenerate the per-feature markdown reports.
// - Reads test-results/results.json (Playwright JSON reporter output)
// - Groups specs by feature folder
// - For each feature, looks up the matching user-story file (for the storyId)
// - Writes reports/<storyId>-<slug>.md with the latest results
// - Preserves any human-authored notes via the AUTO-START / AUTO-END markers

const fs = require('fs');
const path = require('path');

const AUTO_START = '<!-- agentic-qa:auto-start -->';
const AUTO_END = '<!-- agentic-qa:auto-end -->';

function fmtDuration(ms) {
  if (!ms && ms !== 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function fmtStatusBadge(status) {
  switch (status) {
    case 'passed':    return '✅ PASS';
    case 'failed':    return '❌ FAIL';
    case 'timedOut':  return '⏱️ TIMEOUT';
    case 'flaky':     return '⚠️ FLAKY';
    case 'skipped':   return '⏭️ SKIPPED';
    case 'interrupted': return '⛔ INTERRUPTED';
    default:          return status;
  }
}

function fmtLocalDateTime() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Walk the nested suite tree from Playwright's JSON reporter, returning a flat
 * list of { file, title, status, duration, project, errorMessage } records.
 */
function flattenSuites(suite, acc = []) {
  for (const spec of suite.specs || []) {
    for (const test of spec.tests || []) {
      const results = test.results || [];
      const last = results.slice(-1)[0];
      if (!last) continue;
      // Surface 'flaky' from the test object (Playwright sets it when the test
      // failed at least once but eventually passed). Without this, the final
      // retry's status is always 'passed' and the test masquerades as a clean
      // green — violating the framework's anti-false-green rule.
      let status = last.status;
      if (test.status === 'flaky') {
        status = 'flaky';
      } else if (results.length > 1 && last.status === 'passed') {
        // Defensive fallback: multiple attempts with a non-passed earlier
        // attempt indicates flakiness even if test.status isn't set.
        if (results.slice(0, -1).some((r) => r.status !== 'passed' && r.status !== 'skipped')) {
          status = 'flaky';
        }
      }
      acc.push({
        file: suite.file || spec.file || '',
        title: spec.title,
        fullTitle: [suite.title, spec.title].filter(Boolean).join(' › '),
        status,
        duration: last.duration,
        project: test.projectName,
        errorMessage: last.error?.message || (last.errors && last.errors[0]?.message) || null,
      });
    }
  }
  for (const child of suite.suites || []) flattenSuites(child, acc);
  return acc;
}

/**
 * Extract the feature slug from a test file path. The convention is
 * `tests/<feature>/<spec>.spec.ts`. Playwright's JSON reporter strips the
 * `testDir` prefix, so we may see either `tests/<feature>/...` (absolute) or
 * just `<feature>/...` (testDir-relative). Handle both.
 */
function featureFromPath(file) {
  const norm = (file || '').replace(/\\/g, '/');
  // First, strip any leading "tests/" (handles both "tests/x/..." and
  // ".../tests/x/...") so we're always working from <feature>/...
  const stripped = norm.replace(/^(?:.*\/)?tests\//, '');
  const m = stripped.match(/^([^/]+)\//);
  return m ? m[1] : null;
}

/**
 * Locate the user-story file for a feature slug. We expect
 * `user-stories/<STORY-ID>-<slug>.md` but tolerate other formats.
 * Returns { storyId, file } or null.
 *
 * The storyId is whatever precedes `-<slug>` in the filename, so for
 * `SignUp-001-user-signup.md` with slug `user-signup` we return `SignUp-001`.
 */
function extractStoryId(filename, slug) {
  const stem = filename.replace(/\.md$/i, '');
  const suffix = `-${slug}`;
  if (stem.toLowerCase().endsWith(suffix.toLowerCase())) {
    const id = stem.slice(0, stem.length - suffix.length);
    return id || null;
  }
  return null;
}

function findStoryFile(slug, root, paths) {
  const dir = paths?.stories || path.join(root, 'user-stories');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== '_TEMPLATE.md');
  // Exact convention: <storyId>-<slug>.md
  const conv = files.find((f) => f.toLowerCase().endsWith(`-${slug.toLowerCase()}.md`));
  if (conv) {
    return { storyId: extractStoryId(conv, slug), file: conv };
  }
  // Fallback: any file containing the slug — storyId unknown in this case
  const fuzzy = files.find((f) => f.toLowerCase().includes(slug.toLowerCase()));
  if (fuzzy) {
    return { storyId: null, file: fuzzy };
  }
  return null;
}

/**
 * Build the auto-generated markdown block for one feature's results.
 */
function buildAutoBlock(feature, storyId, tests) {
  const total = tests.length;
  const passed = tests.filter((t) => t.status === 'passed').length;
  // 'interrupted' = worker crash / manual cancel — bucket it as failed so an
  // aborted run can't masquerade as a clean PASS.
  const failed = tests.filter((t) => ['failed', 'timedOut', 'interrupted'].includes(t.status)).length;
  const flaky = tests.filter((t) => t.status === 'flaky').length;
  const skipped = tests.filter((t) => t.status === 'skipped').length;
  const interrupted = tests.filter((t) => t.status === 'interrupted').length;
  const totalDuration = tests.reduce((sum, t) => sum + (t.duration || 0), 0);
  const project = tests[0]?.project || '—';

  // Verdict ladder: PASS requires passed+skipped+flaky === total. Anything
  // failed/timedOut/interrupted (or unknown) breaks the green.
  let overallStatus;
  if (failed > 0) {
    overallStatus = `❌ FAIL (${passed}/${total}${interrupted > 0 ? `, ${interrupted} interrupted` : ''})`;
  } else if (passed + skipped + flaky !== total) {
    overallStatus = `⚠️ INCOMPLETE (${passed}/${total})`;
  } else if (skipped === total) {
    overallStatus = `⏭️ ALL SKIPPED`;
  } else if (flaky > 0) {
    overallStatus = `⚠️ FLAKY (${passed} passed, ${flaky} flaky / ${total})`;
  } else {
    overallStatus = `✅ PASS (${passed}/${total})`;
  }

  const rows = tests.map((t) => {
    const file = (t.file || '').replace(/\\/g, '/').split('/').slice(-1)[0];
    const errCol = t.errorMessage
      ? '`' + String(t.errorMessage).split('\n')[0].slice(0, 120).replace(/\|/g, '\\|') + '`'
      : '—';
    return `| \`${file}\` | ${t.fullTitle.replace(/\|/g, '\\|')} | ${fmtStatusBadge(t.status)} | ${fmtDuration(t.duration)} | ${errCol} |`;
  }).join('\n');

  return [
    AUTO_START,
    '',
    `**Last run:** ${fmtLocalDateTime()}`,
    `**Browser:** ${project}`,
    `**Status:** ${overallStatus}`,
    `**Duration:** ${fmtDuration(totalDuration)}`,
    flaky > 0 ? `**Flaky:** ${flaky}` : null,
    skipped > 0 ? `**Skipped:** ${skipped}` : null,
    interrupted > 0 ? `**Interrupted:** ${interrupted}` : null,
    '',
    '## Results',
    '',
    '| Spec | Test | Status | Duration | Error |',
    '|------|------|--------|---------:|-------|',
    rows,
    '',
    '## Artifacts',
    '',
    '- [Playwright HTML report](../playwright-report/index.html)',
    '- [Allure dashboard](../allure-report/index.html)',
    `- Per-test screenshots under \`test-results/${feature}-*/\``,
    '',
    '> This block is regenerated on every run. Edit anywhere outside the markers to add notes that persist across runs.',
    '',
    AUTO_END,
  ].filter((line) => line !== null).join('\n');
}

/**
 * Merge the freshly-built auto block into an existing report file, preserving
 * any content outside the markers. If the file doesn't exist or has no markers,
 * create a fresh one with a stub Notes section.
 */
function mergeReport(filePath, feature, storyTitle, autoBlock) {
  const heading = `# Execution Report — ${storyTitle || feature}`;

  if (!fs.existsSync(filePath)) {
    return [
      heading,
      '',
      autoBlock,
      '',
      '## Notes',
      '',
      '_Add hand-written context here (test design rationale, environment quirks, follow-ups). Anything outside the AUTO markers above is preserved across runs._',
      '',
    ].join('\n');
  }

  const existing = fs.readFileSync(filePath, 'utf8');
  if (existing.includes(AUTO_START) && existing.includes(AUTO_END)) {
    // Replace just the auto block; leave the rest intact (heading, notes, etc.)
    const startIdx = existing.indexOf(AUTO_START);
    const endIdx = existing.indexOf(AUTO_END) + AUTO_END.length;
    return existing.slice(0, startIdx) + autoBlock + existing.slice(endIdx);
  }

  // Legacy hand-written file with no markers — keep its content, prepend a
  // fresh auto block under the heading so future runs can update in place.
  const lines = existing.split('\n');
  const headingIdx = lines.findIndex((l) => l.trim().startsWith('# '));
  if (headingIdx === -1) {
    // No top-level heading — just prepend everything.
    return `${heading}\n\n${autoBlock}\n\n## Previous notes (pre-auto)\n\n${existing}`;
  }
  // Insert the auto block right after the existing heading; legacy content stays below.
  const before = lines.slice(0, headingIdx + 1).join('\n');
  const after = lines.slice(headingIdx + 1).join('\n').replace(/^\n+/, '');
  return `${before}\n\n${autoBlock}\n\n${after}`;
}

/**
 * Main entry — read Playwright JSON, generate one report per feature that had
 * tests in this run. Returns a list of { feature, file, tests }.
 */
function writeRunReports({ root, paths, onLog } = {}) {
  const log = (msg) => { if (onLog) onLog(msg); };
  const testResultsDir = paths?.testResults || path.join(root, 'test-results');
  const jsonPath = path.join(testResultsDir, 'results.json');
  if (!fs.existsSync(jsonPath)) {
    log('[reports] test-results/results.json not found — nothing to regenerate.');
    return [];
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (err) {
    log(`[reports] could not parse results.json: ${err.message}`);
    return [];
  }

  const allTests = [];
  for (const suite of data.suites || []) flattenSuites(suite, allTests);
  if (allTests.length === 0) {
    log('[reports] results.json had no test entries — skipping report regeneration.');
    return [];
  }

  // Group by feature folder
  const byFeature = new Map();
  const unrecognized = [];
  for (const t of allTests) {
    const feat = featureFromPath(t.file);
    if (!feat) { unrecognized.push(t.file); continue; }
    if (!byFeature.has(feat)) byFeature.set(feat, []);
    byFeature.get(feat).push(t);
  }
  if (unrecognized.length > 0) {
    log(`[reports] ${unrecognized.length} test(s) had unrecognized paths and were skipped (expected tests/<feature>/*): ${unrecognized.slice(0, 3).join(', ')}`);
  }
  if (byFeature.size === 0) {
    log(`[reports] no features matched the tests/<feature>/*.spec.ts convention — nothing to regenerate.`);
    return [];
  }

  const reportsDir = paths?.reports || path.join(root, 'reports');
  const storiesDir = paths?.stories || path.join(root, 'user-stories');
  fs.mkdirSync(reportsDir, { recursive: true });

  const written = [];
  for (const [feature, tests] of byFeature) {
    const storyInfo = findStoryFile(feature, root, paths);
    const storyId = storyInfo?.storyId || null;
    const baseName = storyId ? `${storyId}-${feature}` : feature;
    const filePath = path.join(reportsDir, `${baseName}.md`);

    let storyTitle = feature;
    if (storyInfo) {
      try {
        const md = fs.readFileSync(path.join(storiesDir, storyInfo.file), 'utf8');
        const h1 = md.match(/^#\s+(?:User Story:\s+)?(.+)$/m);
        if (h1) storyTitle = h1[1].trim();
      } catch (_) { /* fall back to slug */ }
    }

    const autoBlock = buildAutoBlock(feature, storyId, tests);
    const merged = mergeReport(filePath, feature, storyTitle, autoBlock);
    fs.writeFileSync(filePath, merged, 'utf8');
    log(`[reports] wrote reports/${baseName}.md (${tests.length} test${tests.length === 1 ? '' : 's'})`);
    written.push({ feature, storyId, file: `${baseName}.md`, tests: tests.length });
  }

  return written;
}

module.exports = { writeRunReports };
