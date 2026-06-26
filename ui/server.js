// Simple Express server that powers the UI at http://localhost:3001
// - Lists features in tests/
// - Saves a user-story file
// - Runs Playwright tests in headed mode and streams output as NDJSON
// - Rebuilds the Allure HTML report after every run
//
// No paid-API features. POM + spec generation and self-healing are done via
// the Claude Code path (see QAEnd2EndPromptFile.md), or by hand-authoring.

const express = require('express');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const { renderReport } = require('./report-renderer');
const { writeRunReports } = require('./report-writer');
const { writeTestCasesExcel } = require('./excel-writer');

const app = express();
const PORT = process.env.UI_PORT ? Number(process.env.UI_PORT) : 3001;
// Bind to loopback by default; opt into LAN with UI_HOST=0.0.0.0 (or a
// specific IP) — combined with the spawn surface that's not safe to expose
// to arbitrary network peers.
const HOST = process.env.UI_HOST || '127.0.0.1';

// ROOT = consumer's project root. When invoked via the CLI (`agentic-qa ui`),
// AGENTIC_QA_CWD is set to the consumer's cwd. When run standalone in this
// framework's own repo (`npm run ui`), fall back to the repo root.
const ROOT = process.env.AGENTIC_QA_CWD
  ? path.resolve(process.env.AGENTIC_QA_CWD)
  : path.resolve(__dirname, '..');

// Resolve consumer-overridable paths. AGENTIC_QA_CONFIG_JSON is set by the
// CLI's `agentic-qa ui` after running loadConfig(); when running standalone
// (`npm run ui` in the framework's own repo) we fall back to repo defaults.
let CFG_PATHS = {
  tests: path.join(ROOT, 'tests'),
  stories: path.join(ROOT, 'user-stories'),
  reports: path.join(ROOT, 'reports'),
  testResults: path.join(ROOT, 'test-results'),
  allureResults: path.join(ROOT, 'allure-results'),
  allureReport: path.join(ROOT, 'allure-report'),
  playwrightReport: path.join(ROOT, 'playwright-report'),
};
if (process.env.AGENTIC_QA_CONFIG_JSON) {
  try {
    const cfg = JSON.parse(process.env.AGENTIC_QA_CONFIG_JSON);
    if (cfg && cfg.paths) Object.assign(CFG_PATHS, cfg.paths);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[ui] could not parse AGENTIC_QA_CONFIG_JSON — using defaults:', err.message);
  }
}

// Validation: feature folder names and Playwright project names must match a
// safe subset to prevent argv/shell injection on Windows (we spawn with
// shell:true so cmd.exe parses the argv).
const SAFE_NAME_RE = /^[A-Za-z0-9._-]+$/;
function isSafeName(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 64 && SAFE_NAME_RE.test(s);
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

function safeSlug(input) {
  return String(input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled';
}

// List feature folders. A feature has either .spec.ts files under tests/<name>/
// or .feature files under features/<name>/ (Gherkin/BDD). Both counts are
// surfaced in the response so the UI can show a single row per feature.
app.get('/api/features', (_req, res) => {
  try {
    const featureMap = new Map();
    // 1) Classic POM tests
    if (fs.existsSync(CFG_PATHS.tests)) {
      for (const name of fs.readdirSync(CFG_PATHS.tests)) {
        const stat = fs.statSync(path.join(CFG_PATHS.tests, name), { throwIfNoEntry: false });
        if (!stat || !stat.isDirectory()) continue;
        let specs = 0;
        try { specs = fs.readdirSync(path.join(CFG_PATHS.tests, name)).filter((f) => f.endsWith('.spec.ts')).length; } catch (_) {}
        featureMap.set(name, { name, specs, features: 0 });
      }
    }
    // 2) Gherkin .feature files
    const featuresDir = path.join(ROOT, 'features');
    if (fs.existsSync(featuresDir)) {
      for (const name of fs.readdirSync(featuresDir)) {
        const stat = fs.statSync(path.join(featuresDir, name), { throwIfNoEntry: false });
        if (!stat || !stat.isDirectory()) continue;
        let count = 0;
        try { count = fs.readdirSync(path.join(featuresDir, name)).filter((f) => f.endsWith('.feature')).length; } catch (_) {}
        const existing = featureMap.get(name);
        if (existing) existing.features = count;
        else featureMap.set(name, { name, specs: 0, features: count });
      }
    }
    res.json(Array.from(featureMap.values()));
  } catch (err) {
    res.status(500).json({ error: String(err && err.message) });
  }
});

// Save a user-story file from form input. Manual authoring path — no AI.
app.post('/api/save-story', (req, res) => {
  try {
    const { url, title, ac, creds, storyId } = req.body || {};
    if (!url || !title || !ac) {
      return res.status(400).json({ error: 'url, title, and ac are required' });
    }
    const slug = safeSlug(title);
    // Validate storyId aggressively — it lands in a path literal, so any
    // separator characters open a path-traversal write.
    const rawId = (storyId || '').trim();
    if (rawId && !/^[A-Za-z0-9_-]{1,64}$/.test(rawId)) {
      return res.status(400).json({ error: 'storyId must match /^[A-Za-z0-9_-]{1,64}$/' });
    }
    const id = rawId || `UI-${Date.now().toString(36).toUpperCase()}`;
    const fileName = `${id}-${slug}.md`;
    const dir = CFG_PATHS.stories;
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, fileName);
    // Defense-in-depth — even after regex validation, refuse to write
    // outside the stories dir if path.resolve escapes it.
    if (!path.resolve(filePath).startsWith(path.resolve(dir) + path.sep)) {
      return res.status(400).json({ error: 'resolved path escapes user-stories directory' });
    }

    const content =
      `# User Story: ${id} - ${title}\n\n` +
      `## Application URL\n${url}\n\n` +
      (creds ? `## Test Credentials\n${creds}\n\n` : '') +
      `## Acceptance Criteria\n${ac}\n`;

    fs.writeFileSync(filePath, content, 'utf8');
    res.json({ ok: true, file: `user-stories/${fileName}`, storyId: id, slug });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message) });
  }
});

// Locate a JDK install on Windows so allure (a Java tool) can run from this
// process even if JAVA_HOME isn't set in the parent shell yet. When multiple
// jdk-N.x.x directories exist, pick the highest version.
function envWithJava() {
  const env = { ...process.env };
  if (env.JAVA_HOME && fs.existsSync(path.join(env.JAVA_HOME, 'bin'))) return env;
  if (process.platform === 'win32') {
    const root = 'C:\\Program Files\\Microsoft';
    if (fs.existsSync(root)) {
      const jdks = fs.readdirSync(root)
        .filter((name) => /^jdk-\d/.test(name))
        .map((name) => {
          const v = name.replace(/^jdk-/, '').split('.').map((n) => parseInt(n, 10) || 0);
          return { name, key: v[0] * 1e6 + v[1] * 1e3 + (v[2] || 0) };
        })
        .sort((a, b) => b.key - a.key);
      if (jdks.length > 0) {
        const home = path.join(root, jdks[0].name);
        env.JAVA_HOME = home;
        env.PATH = path.join(home, 'bin') + path.delimiter + (env.PATH || '');
      }
    }
  }
  return env;
}

// Kill a process tree. On Windows, SIGTERM only signals the cmd.exe wrapper
// (because we spawn with shell:true), leaving the node/playwright/browser
// tree alive. taskkill /T walks the tree.
function killProcessTree(proc) {
  if (!proc || proc.killed) return;
  if (process.platform === 'win32' && proc.pid) {
    exec(`taskkill /pid ${proc.pid} /T /F`, () => {});
  } else {
    try { proc.kill('SIGTERM'); } catch (_) { /* already dead */ }
  }
}

// Safe write helper bound to a response. Suppresses ERR_STREAM_WRITE_AFTER_END
// when the client disconnects mid-stream; returns false if the stream is gone.
function makeSafeWrite(res) {
  return (obj) => {
    if (res.writableEnded || res.destroyed) return false;
    try {
      res.write(JSON.stringify(obj) + '\n');
      return true;
    } catch (_) {
      return false;
    }
  };
}

// Compile .feature → .spec.js via playwright-bdd. Best-effort: resolves
// even on failure (the actual test run will surface any real issue).
function runBddgen(write) {
  return new Promise((resolve) => {
    if (!fs.existsSync(path.join(ROOT, 'features'))) return resolve(); // nothing to compile
    write({ type: 'log', stream: 'stdout', text: '[ui] compiling .feature files (bddgen)…\n' });
    const proc = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['bddgen', '--config', 'playwright.config.js'],
      { cwd: ROOT, env: process.env, shell: process.platform === 'win32' });
    proc.stdout.on('data', (d) => write({ type: 'log', stream: 'stdout', text: d.toString() }));
    proc.stderr.on('data', (d) => write({ type: 'log', stream: 'stderr', text: d.toString() }));
    proc.on('close', (code) => {
      if (code !== 0) write({ type: 'log', stream: 'stderr', text: `[ui] bddgen exited ${code} — feature files may not run\n` });
      resolve();
    });
    proc.on('error', (err) => {
      write({ type: 'log', stream: 'stderr', text: `[ui] bddgen spawn failed: ${err.message}\n` });
      resolve();
    });
  });
}

// Spawn Playwright, stream its output via the NDJSON `write` callback,
// resolve with the process exit code. Caller can stash the live process
// (via onProcCreated) so it can be killed if the response disconnects.
function runPlaywrightProcess(args, write, onProcCreated) {
  return new Promise((resolve) => {
    const proc = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, {
      cwd: ROOT,
      env: process.env,
      shell: process.platform === 'win32',
    });
    onProcCreated?.(proc);
    proc.stdout.on('data', (data) => write({ type: 'log', stream: 'stdout', text: data.toString() }));
    proc.stderr.on('data', (data) => write({ type: 'log', stream: 'stderr', text: data.toString() }));
    proc.on('error', (err) => {
      write({ type: 'log', stream: 'stderr', text: `[ui] spawn failed: ${err.message}\n` });
      resolve(1);
    });
    proc.on('close', (code) => resolve(code == null ? 1 : code));
  });
}

// Rebuild Allure HTML so /allure-report/index.html reflects the latest run.
// Best-effort: resolves regardless of success (logs failure but doesn't throw).
function rebuildAllure(write, onProcCreated) {
  return new Promise((resolve) => {
    if (!fs.existsSync(CFG_PATHS.allureResults) || fs.readdirSync(CFG_PATHS.allureResults).length === 0) {
      write({ type: 'log', stream: 'stdout', text: '[ui] no allure-results to render; skipping report rebuild\n' });
      return resolve();
    }
    write({ type: 'log', stream: 'stdout', text: '[ui] rebuilding Allure HTML report…\n' });
    const proc = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['allure', 'generate', path.relative(ROOT, CFG_PATHS.allureResults) || 'allure-results',
        '--clean', '-o', path.relative(ROOT, CFG_PATHS.allureReport) || 'allure-report'],
      { cwd: ROOT, env: envWithJava(), shell: process.platform === 'win32' });
    onProcCreated?.(proc);
    proc.stdout.on('data', (d) => write({ type: 'log', stream: 'stdout', text: d.toString() }));
    proc.stderr.on('data', (d) => write({ type: 'log', stream: 'stderr', text: d.toString() }));
    proc.on('close', (code) => {
      if (code === 0) write({ type: 'log', stream: 'stdout', text: '[ui] Allure report rebuilt at /allure-report/index.html\n' });
      else write({ type: 'log', stream: 'stderr', text: `[ui] allure generate exited ${code} (Java missing or path issue) — Playwright HTML report is still valid\n` });
      resolve();
    });
    proc.on('error', (err) => {
      write({ type: 'log', stream: 'stderr', text: `[ui] allure spawn failed: ${err.message}\n` });
      resolve();
    });
  });
}

function clearAllureResults(write) {
  try {
    if (fs.existsSync(CFG_PATHS.allureResults)) {
      fs.rmSync(CFG_PATHS.allureResults, { recursive: true, force: true });
      write({ type: 'log', stream: 'stdout', text: '[ui] cleared allure-results/ for fresh run\n' });
    }
  } catch (_) { /* best-effort */ }
}

// Track the active Playwright run so /api/abort can kill it from a separate
// HTTP request. Only one run is allowed at a time anyway (the UI disables
// the button while a run is in flight), so a single global slot is fine.
let activeRun = null;

// Stop the active Playwright run, if any. Returns 204 if a kill was sent,
// 404 if nothing was running.
app.post('/api/abort', (_req, res) => {
  if (activeRun && activeRun.proc && !activeRun.proc.killed) {
    killProcessTree(activeRun.proc);
    return res.status(204).end();
  }
  res.status(404).json({ error: 'no active run' });
});

// Return a flat list of failed tests from the last Playwright JSON results.
// Each entry: { title, file, line, error, screenshot, trace }
app.get('/api/last-failures', (_req, res) => {
  try {
    const jsonPath = path.join(CFG_PATHS.testResults, 'results.json');
    if (!fs.existsSync(jsonPath)) return res.json({ failures: [], runTimestamp: null });
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const failures = [];
    const FAIL_STATUSES = new Set(['failed', 'timedOut', 'interrupted']);
    const visit = (suite, parentTitles = []) => {
      const titles = suite.title ? [...parentTitles, suite.title] : parentTitles;
      for (const spec of suite.specs || []) {
        for (const test of spec.tests || []) {
          const last = (test.results || []).slice(-1)[0];
          if (!last || !FAIL_STATUSES.has(last.status)) continue;
          // Find screenshot + trace attachments in this test result.
          let screenshot = null, trace = null;
          for (const att of last.attachments || []) {
            if (!att.path) continue;
            const rel = path.relative(CFG_PATHS.testResults, att.path).split(path.sep).join('/');
            const url = `/test-results/${rel}`;
            if (att.contentType?.includes('image/') && !screenshot) screenshot = url;
            else if (att.name === 'trace' || att.path.endsWith('.zip')) trace = url;
          }
          failures.push({
            title: spec.title,
            fullTitle: [...titles, spec.title].filter(Boolean).join(' › '),
            file: (suite.file || spec.file || '').replace(/\\/g, '/'),
            line: spec.line,
            project: test.projectName,
            duration: last.duration,
            status: last.status,
            errorMessage: last.error?.message || (last.errors && last.errors[0]?.message) || null,
            errorStack: last.error?.stack || null,
            screenshot,
            trace,
          });
        }
      }
      for (const child of suite.suites || []) visit(child, titles);
    };
    for (const top of data.suites || []) visit(top);
    res.json({
      failures,
      runTimestamp: data.stats?.startTime || null,
      duration: data.stats?.duration || null,
    });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message) });
  }
});

// Run Playwright with NDJSON streaming so the browser can read the log live.
// Flow: clear allure → run → rebuild allure → done.
app.post('/api/run', async (req, res) => {
  const { feature, project, headed, lastFailed } = req.body || {};

  // Validate input. Empty/undefined feature = run all features (no path arg);
  // any provided feature/project must match the safe-name regex AND, for
  // feature, refer to an existing directory under testsDir.
  if (feature !== undefined && feature !== null && feature !== '') {
    if (!isSafeName(feature)) {
      return res.status(400).json({ error: `feature must match ${SAFE_NAME_RE} (got "${feature}")` });
    }
    if (!fs.existsSync(path.join(CFG_PATHS.tests, feature))) {
      return res.status(404).json({ error: `feature "${feature}" does not exist under tests/` });
    }
  }
  if (project !== undefined && project !== null && project !== '') {
    if (!isSafeName(project)) {
      return res.status(400).json({ error: `project must match ${SAFE_NAME_RE} (got "${project}")` });
    }
  }

  // Refuse to start a new run while one is already in flight — check BEFORE
  // we commit to streaming response headers.
  if (activeRun) {
    return res.status(409).json({ error: 'a run is already in progress; abort or wait' });
  }

  const testsRel = path.relative(ROOT, CFG_PATHS.tests).split(path.sep).join('/') || 'tests';
  const args = ['playwright', 'test'];
  const hasBdd = fs.existsSync(path.join(ROOT, 'features'));
  const runBdd = project === 'chromium' && hasBdd;
  // --last-failed runs only the tests that failed in the previous run.
  // Playwright doesn't combine it with a path filter, so when lastFailed=true
  // we skip the feature/tests filter entirely.
  if (lastFailed) {
    args.push('--last-failed');
  } else if (feature) {
    // Specific feature picked → push the classic test path + (if BDD runs)
    // the matching compiled-feature path. Both projects respect path filters.
    args.push(`${testsRel}/${feature}/`);
    if (runBdd) args.push(`.features-gen/features/${feature}/`);
  }
  // (no path filter when no feature is selected — Playwright runs everything
  // under each project's testDir, including .features-gen/ for chromium-bdd)
  if (project) {
    args.push(`--project=${project}`);
    // When chromium is picked, also run the BDD project so .feature scenarios
    // execute in the same browser. The BDD project is chromium-only by design.
    if (runBdd) args.push('--project=chromium-bdd');
  }
  if (headed !== false) {
    args.push('--headed');
    // In headed mode, force a single worker so the user can actually watch
    // each test execute in sequence (8 parallel browser windows are unusable).
    args.push('--workers=1');
  }

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  // Eat EPIPE / connection errors so a client disconnect doesn't crash Node.
  res.on('error', () => {});

  const write = makeSafeWrite(res);

  let currentProc = null;
  let finished = false;
  res.on('close', () => {
    if (!finished && currentProc && !currentProc.killed) killProcessTree(currentProc);
  });

  try {
    clearAllureResults(write);
    // Compile .feature files first so BDD scenarios are present in the
    // generated dir before Playwright walks the testDir.
    await runBddgen(write);
    write({ type: 'start', cmd: 'npx ' + args.join(' '), cwd: ROOT });
    const code = await runPlaywrightProcess(args, write, (p) => {
      currentProc = p;
      activeRun = { proc: p, startedAt: Date.now() };
    });
    activeRun = null;
    currentProc = null;

    // Regenerate per-feature markdown reports from this run's JSON results,
    // preserving any hand-written notes via the AUTO markers.
    try {
      const written = writeRunReports({
        root: ROOT,
        paths: CFG_PATHS,
        onLog: (msg) => write({ type: 'log', stream: 'stdout', text: msg + '\n' }),
      });
      if (written.length > 0) write({ type: 'reports_written', files: written });
    } catch (err) {
      write({ type: 'log', stream: 'stderr', text: `[reports] regeneration failed: ${err.message}\n` });
    }

    // Regenerate consolidated test-case Excel (reports/Test-Cases.xlsx)
    // joining tests/<feature>/testcases.json with the latest run results.
    try {
      const excel = await writeTestCasesExcel({
        root: ROOT,
        paths: CFG_PATHS,
        onLog: (msg) => write({ type: 'log', stream: 'stdout', text: msg + '\n' }),
      });
      if (excel) write({ type: 'excel_written', file: excel.path, features: excel.features });
    } catch (err) {
      write({ type: 'log', stream: 'stderr', text: `[excel] generation failed: ${err.message}\n` });
    }

    await rebuildAllure(write, (p) => { currentProc = p; });
    currentProc = null;

    finished = true;
    write({ type: 'done', exitCode: code });
    if (!res.writableEnded) res.end();
  } catch (err) {
    finished = true;
    activeRun = null;
    write({ type: 'error', message: String((err && err.message) || err) });
    write({ type: 'done', exitCode: 1 });
    if (!res.writableEnded) res.end();
  } finally {
    activeRun = null;
  }
});

// Generate Allure HTML report on demand (needs Java).
app.post('/api/allure-generate', (req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.on('error', () => {});
  const write = makeSafeWrite(res);
  write({ type: 'start', cmd: 'npx allure generate allure-results --clean -o allure-report' });

  const proc = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['allure', 'generate', path.relative(ROOT, CFG_PATHS.allureResults) || 'allure-results',
      '--clean', '-o', path.relative(ROOT, CFG_PATHS.allureReport) || 'allure-report'],
    { cwd: ROOT, env: envWithJava(), shell: process.platform === 'win32' });

  let finished = false;
  res.on('close', () => {
    if (!finished && !proc.killed) killProcessTree(proc);
  });
  proc.stdout.on('data', (d) => write({ type: 'log', stream: 'stdout', text: d.toString() }));
  proc.stderr.on('data', (d) => write({ type: 'log', stream: 'stderr', text: d.toString() }));
  proc.on('error', (err) => {
    finished = true;
    write({ type: 'log', stream: 'stderr', text: `[ui] allure spawn failed: ${err.message}\n` });
    write({ type: 'done', exitCode: 1 });
    if (!res.writableEnded) res.end();
  });
  proc.on('close', (code) => {
    finished = true;
    write({ type: 'done', exitCode: code });
    if (!res.writableEnded) res.end();
  });
});

// Static report passthrough so the UI can iframe/preview existing reports
app.use('/playwright-report', express.static(CFG_PATHS.playwrightReport));
app.use('/allure-report', express.static(CFG_PATHS.allureReport));
app.use('/reports', express.static(CFG_PATHS.reports));

// Modern rendered view of AI reports (vs raw markdown via /reports/...).
app.get('/reports-view/:filename', (req, res) => {
  const result = renderReport(CFG_PATHS.reports, req.params.filename);
  res.status(result.status).type('text/html; charset=utf-8').send(result.html);
});
app.use('/test-results', express.static(CFG_PATHS.testResults));

// List screenshots from the latest Playwright run as a flat array of
// { test, file, url, ts } so the UI can render a gallery.
app.get('/api/screenshots', (_req, res) => {
  try {
    const items = [];
    if (!fs.existsSync(CFG_PATHS.testResults)) return res.json([]);
    let dirs = [];
    try { dirs = fs.readdirSync(CFG_PATHS.testResults); } catch (_) { return res.json([]); }
    for (const dir of dirs) {
      const sub = path.join(CFG_PATHS.testResults, dir);
      const subStat = fs.statSync(sub, { throwIfNoEntry: false });
      if (!subStat || !subStat.isDirectory()) continue;
      let files = [];
      try { files = fs.readdirSync(sub); } catch (_) { continue; }
      for (const f of files) {
        if (!/\.(png|jpe?g)$/i.test(f)) continue;
        const stat = fs.statSync(path.join(sub, f), { throwIfNoEntry: false });
        if (!stat) continue;
        items.push({
          test: dir,
          file: f,
          url: `/test-results/${encodeURIComponent(dir)}/${encodeURIComponent(f)}`,
          ts: stat.mtimeMs,
        });
      }
    }
    items.sort((a, b) => b.ts - a.ts);
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: String(err && err.message) });
  }
});

app.get('/api/report-status', (_req, res) => {
  try {
    const allReports = fs.existsSync(CFG_PATHS.reports) ? fs.readdirSync(CFG_PATHS.reports) : [];
    res.json({
      playwright: fs.existsSync(path.join(CFG_PATHS.playwrightReport, 'index.html')),
      allure: fs.existsSync(path.join(CFG_PATHS.allureReport, 'index.html')),
      aiReports: allReports.filter((f) => f.endsWith('.md')),
      excelReports: allReports.filter((f) => f.endsWith('.xlsx')),
    });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message) });
  }
});

app.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`\nAgentic QA Pipeline UI: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}${HOST === '0.0.0.0' ? ' (also reachable on LAN)' : ''}\n`);
});
