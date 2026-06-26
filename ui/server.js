// Simple Express server that powers the UI at http://localhost:3001
// - Lists features in tests/
// - Saves a user-story file
// - Runs Playwright tests in headed mode and streams output as NDJSON
// - Rebuilds the Allure HTML report after every run
//
// No paid-API features. POM + spec generation and self-healing are done via
// the Claude Code path (see QAEnd2EndPromptFile.md), or by hand-authoring.

const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { renderReport } = require('./report-renderer');
const { writeRunReports } = require('./report-writer');
const { writeTestCasesExcel } = require('./excel-writer');

const app = express();
const PORT = process.env.UI_PORT ? Number(process.env.UI_PORT) : 3001;

// ROOT = consumer's project root. When invoked via the CLI (`agentic-qa ui`),
// AGENTIC_QA_CWD is set to the consumer's cwd. When run standalone in this
// framework's own repo (`npm run ui`), fall back to the repo root.
const ROOT = process.env.AGENTIC_QA_CWD
  ? path.resolve(process.env.AGENTIC_QA_CWD)
  : path.resolve(__dirname, '..');

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

// List feature folders under tests/
app.get('/api/features', (_req, res) => {
  const testsDir = path.join(ROOT, 'tests');
  if (!fs.existsSync(testsDir)) return res.json([]);
  const features = fs
    .readdirSync(testsDir)
    .filter((name) => {
      const p = path.join(testsDir, name);
      return fs.statSync(p).isDirectory();
    })
    .map((name) => {
      const dir = path.join(testsDir, name);
      const specs = fs.readdirSync(dir).filter((f) => f.endsWith('.spec.ts')).length;
      return { name, specs };
    });
  res.json(features);
});

// Save a user-story file from form input. Manual authoring path — no AI.
app.post('/api/save-story', (req, res) => {
  try {
    const { url, title, ac, creds, storyId } = req.body || {};
    if (!url || !title || !ac) {
      return res.status(400).json({ error: 'url, title, and ac are required' });
    }
    const slug = safeSlug(title);
    const id = (storyId && storyId.trim()) || `UI-${Date.now().toString(36).toUpperCase()}`;
    const fileName = `${id}-${slug}.md`;
    const dir = path.join(ROOT, 'user-stories');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, fileName);

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
// process even if JAVA_HOME isn't set in the parent shell yet.
function envWithJava() {
  const env = { ...process.env };
  if (env.JAVA_HOME && fs.existsSync(path.join(env.JAVA_HOME, 'bin'))) return env;
  if (process.platform === 'win32') {
    const root = 'C:\\Program Files\\Microsoft';
    if (fs.existsSync(root)) {
      const jdk = fs.readdirSync(root).find((name) => name.startsWith('jdk-'));
      if (jdk) {
        const home = path.join(root, jdk);
        env.JAVA_HOME = home;
        env.PATH = path.join(home, 'bin') + path.delimiter + (env.PATH || '');
      }
    }
  }
  return env;
}

// Spawn Playwright, stream its output via the NDJSON `write` callback,
// resolve with the process exit code. Caller can stash the live process
// (via onProcCreated) so it can be killed if the response disconnects.
function runPlaywrightProcess(args, write, onProcCreated) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, {
      cwd: ROOT,
      env: process.env,
      shell: process.platform === 'win32',
    });
    onProcCreated?.(proc);
    proc.stdout.on('data', (data) => write({ type: 'log', stream: 'stdout', text: data.toString() }));
    proc.stderr.on('data', (data) => write({ type: 'log', stream: 'stderr', text: data.toString() }));
    proc.on('error', reject);
    proc.on('close', (code) => resolve(code));
  });
}

// Rebuild Allure HTML so /allure-report/index.html reflects the latest run.
// Best-effort: resolves regardless of success (logs failure but doesn't throw).
function rebuildAllure(write) {
  return new Promise((resolve) => {
    const allureResults = path.join(ROOT, 'allure-results');
    if (!fs.existsSync(allureResults) || fs.readdirSync(allureResults).length === 0) {
      write({ type: 'log', stream: 'stdout', text: '[ui] no allure-results to render; skipping report rebuild\n' });
      return resolve();
    }
    write({ type: 'log', stream: 'stdout', text: '[ui] rebuilding Allure HTML report…\n' });
    const proc = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['allure', 'generate', 'allure-results', '--clean', '-o', 'allure-report'],
      { cwd: ROOT, env: envWithJava(), shell: process.platform === 'win32' });
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
    const allureResults = path.join(ROOT, 'allure-results');
    if (fs.existsSync(allureResults)) {
      fs.rmSync(allureResults, { recursive: true, force: true });
      write({ type: 'log', stream: 'stdout', text: '[ui] cleared allure-results/ for fresh run\n' });
    }
  } catch (_) { /* best-effort */ }
}

// Run Playwright with NDJSON streaming so the browser can read the log live.
// Flow: clear allure → run → rebuild allure → done.
app.post('/api/run', async (req, res) => {
  const { feature, project, headed } = req.body || {};
  const args = ['playwright', 'test', feature ? `tests/${feature}/` : 'tests/'];
  if (project) args.push(`--project=${project}`);
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

  const write = (obj) => res.write(JSON.stringify(obj) + '\n');

  let currentProc = null;
  let finished = false;
  res.on('close', () => {
    if (!finished && currentProc && !currentProc.killed) currentProc.kill('SIGTERM');
  });

  try {
    clearAllureResults(write);
    write({ type: 'start', cmd: 'npx ' + args.join(' '), cwd: ROOT });
    const code = await runPlaywrightProcess(args, write, (p) => { currentProc = p; });

    // Regenerate per-feature markdown reports from this run's JSON results,
    // preserving any hand-written notes via the AUTO markers.
    try {
      const written = writeRunReports({
        root: ROOT,
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
        onLog: (msg) => write({ type: 'log', stream: 'stdout', text: msg + '\n' }),
      });
      if (excel) write({ type: 'excel_written', file: excel.path, features: excel.features });
    } catch (err) {
      write({ type: 'log', stream: 'stderr', text: `[excel] generation failed: ${err.message}\n` });
    }

    await rebuildAllure(write);

    finished = true;
    write({ type: 'done', exitCode: code });
    res.end();
  } catch (err) {
    finished = true;
    write({ type: 'error', message: String((err && err.message) || err) });
    write({ type: 'done', exitCode: 1 });
    res.end();
  }
});

// Generate Allure HTML report on demand (needs Java).
app.post('/api/allure-generate', (req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  const write = (obj) => res.write(JSON.stringify(obj) + '\n');
  write({ type: 'start', cmd: 'npx allure generate allure-results --clean -o allure-report' });

  const proc = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['allure', 'generate', 'allure-results', '--clean', '-o', 'allure-report'],
    { cwd: ROOT, env: envWithJava(), shell: process.platform === 'win32' });

  proc.stdout.on('data', (d) => write({ type: 'log', stream: 'stdout', text: d.toString() }));
  proc.stderr.on('data', (d) => write({ type: 'log', stream: 'stderr', text: d.toString() }));
  proc.on('close', (code) => { write({ type: 'done', exitCode: code }); res.end(); });
});

// Static report passthrough so the UI can iframe/preview existing reports
app.use('/playwright-report', express.static(path.join(ROOT, 'playwright-report')));
app.use('/allure-report', express.static(path.join(ROOT, 'allure-report')));
app.use('/reports', express.static(path.join(ROOT, 'reports')));

// Modern rendered view of AI reports (vs raw markdown via /reports/...).
app.get('/reports-view/:filename', (req, res) => {
  const result = renderReport(path.join(ROOT, 'reports'), req.params.filename);
  res.status(result.status).type('text/html; charset=utf-8').send(result.html);
});
app.use('/test-results', express.static(path.join(ROOT, 'test-results')));

// List screenshots from the latest Playwright run as a flat array of
// { test, file, url, ts } so the UI can render a gallery.
app.get('/api/screenshots', (_req, res) => {
  const results = path.join(ROOT, 'test-results');
  const items = [];
  if (!fs.existsSync(results)) return res.json([]);
  for (const dir of fs.readdirSync(results)) {
    const sub = path.join(results, dir);
    if (!fs.statSync(sub).isDirectory()) continue;
    for (const f of fs.readdirSync(sub)) {
      if (!/\.(png|jpe?g)$/i.test(f)) continue;
      items.push({
        test: dir,
        file: f,
        url: `/test-results/${encodeURIComponent(dir)}/${encodeURIComponent(f)}`,
        ts: fs.statSync(path.join(sub, f)).mtimeMs,
      });
    }
  }
  items.sort((a, b) => b.ts - a.ts);
  res.json(items);
});

app.get('/api/report-status', (_req, res) => {
  const reportsDir = path.join(ROOT, 'reports');
  const allReports = fs.existsSync(reportsDir) ? fs.readdirSync(reportsDir) : [];
  res.json({
    playwright: fs.existsSync(path.join(ROOT, 'playwright-report', 'index.html')),
    allure: fs.existsSync(path.join(ROOT, 'allure-report', 'index.html')),
    aiReports: allReports.filter((f) => f.endsWith('.md')),
    excelReports: allReports.filter((f) => f.endsWith('.xlsx')),
  });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`\nAgentic QA Pipeline UI: http://localhost:${PORT}\n`);
});
