// Simple Express server that powers the UI at http://localhost:3001
// - Lists features in tests/
// - Saves a user story file
// - Runs Playwright tests in headed mode and streams output as NDJSON

const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { explorePage, generateFiles } = require('./generator');
const { renderReport } = require('./report-renderer');

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

// Save a user-story file (Express prompt's first step, decoupled so the UI can do it standalone)
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

// Run Playwright with NDJSON streaming so the browser can read the log live.
// After tests finish, also wipe allure-results/ for this run and rebuild the
// HTML report so the "Allure" link in the UI footer always reflects the latest run.
app.post('/api/run', (req, res) => {
  const { feature, project, headed } = req.body || {};
  const testPath = feature ? `tests/${feature}/` : 'tests/';
  const args = ['playwright', 'test', testPath];
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

  // Clear previous Allure results so the upcoming report reflects only this run.
  // (Otherwise the report accumulates across runs and looks "stuck" on an old count.)
  try {
    const allureResults = path.join(ROOT, 'allure-results');
    if (fs.existsSync(allureResults)) {
      fs.rmSync(allureResults, { recursive: true, force: true });
      write({ type: 'log', stream: 'stdout', text: '[ui] cleared allure-results/ for fresh run\n' });
    }
  } catch (e) { /* best-effort */ }

  write({ type: 'start', cmd: 'npx ' + args.join(' '), cwd: ROOT });

  // Windows-friendly spawn (npm script wraps `playwright` via npx)
  const proc = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, {
    cwd: ROOT,
    env: process.env,
    shell: process.platform === 'win32',
  });

  proc.stdout.on('data', (data) => write({ type: 'log', stream: 'stdout', text: data.toString() }));
  proc.stderr.on('data', (data) => write({ type: 'log', stream: 'stderr', text: data.toString() }));

  proc.on('error', (err) => write({ type: 'error', message: String(err && err.message) }));

  let finished = false;
  proc.on('close', (code) => {
    finished = true;

    // Rebuild Allure HTML so /allure-report/index.html reflects this run.
    const allureResults = path.join(ROOT, 'allure-results');
    if (!fs.existsSync(allureResults) || fs.readdirSync(allureResults).length === 0) {
      write({ type: 'log', stream: 'stdout', text: '[ui] no allure-results to render; skipping report rebuild\n' });
      write({ type: 'done', exitCode: code });
      return res.end();
    }

    write({ type: 'log', stream: 'stdout', text: '[ui] rebuilding Allure HTML report…\n' });
    const allureArgs = ['allure', 'generate', 'allure-results', '--clean', '-o', 'allure-report'];
    const allureProc = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', allureArgs, {
      cwd: ROOT,
      env: envWithJava(),
      shell: process.platform === 'win32',
    });

    allureProc.stdout.on('data', (data) => write({ type: 'log', stream: 'stdout', text: data.toString() }));
    allureProc.stderr.on('data', (data) => write({ type: 'log', stream: 'stderr', text: data.toString() }));

    allureProc.on('close', (allureCode) => {
      if (allureCode === 0) {
        write({ type: 'log', stream: 'stdout', text: '[ui] Allure report rebuilt at /allure-report/index.html\n' });
      } else {
        write({ type: 'log', stream: 'stderr', text: `[ui] allure generate exited ${allureCode} (Java missing or path issue) — Playwright HTML report is still valid\n` });
      }
      write({ type: 'done', exitCode: code });
      res.end();
    });

    allureProc.on('error', (err) => {
      write({ type: 'log', stream: 'stderr', text: `[ui] allure spawn failed: ${err.message}\n` });
      write({ type: 'done', exitCode: code });
      res.end();
    });
  });

  // Only kill the child if the *response* connection drops before finish.
  // Avoids Express 5's `req.on('close')` firing as soon as the request body has
  // been fully consumed, which would prematurely SIGTERM the test run.
  res.on('close', () => {
    if (!finished && !proc.killed) proc.kill('SIGTERM');
  });
});

// AI-powered generation: explore URL → call Claude API → write POM + spec files
app.post('/api/generate', async (req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const write = (obj) => res.write(JSON.stringify(obj) + '\n');
  const log = (text) => write({ type: 'log', text: text + '\n' });

  if (!process.env.ANTHROPIC_API_KEY) {
    write({
      type: 'error',
      message:
        'ANTHROPIC_API_KEY is not set. Set it in your environment, restart `npm run ui`, then try again. Get a key at https://console.anthropic.com',
    });
    write({ type: 'done', ok: false });
    return res.end();
  }

  try {
    const { url, title, story, ac, creds, storyId } = req.body || {};
    if (!url || !title || !ac) {
      write({ type: 'error', message: 'url, title, and ac are required' });
      write({ type: 'done', ok: false });
      return res.end();
    }

    const slug = safeSlug(title);
    const id = (storyId && storyId.trim()) || `AUTO-${Date.now().toString(36).toUpperCase()}`;

    write({ type: 'start', storyId: id, slug });
    log(`Story ID: ${id}`);
    log(`Feature slug: ${slug}`);

    // 1. Save the user story file
    log('Writing user-story file…');
    const storyContent =
      `# User Story: ${id} - ${title}\n\n` +
      (story ? `## Story Description\n${story}\n\n` : '') +
      `## Application URL\n${url}\n\n` +
      (creds ? `## Test Credentials\n${creds}\n\n` : '') +
      `## Acceptance Criteria\n${ac}\n`;
    const storyDir = path.join(ROOT, 'user-stories');
    fs.mkdirSync(storyDir, { recursive: true });
    const storyFile = path.join(storyDir, `${id}-${slug}.md`);
    fs.writeFileSync(storyFile, storyContent, 'utf8');
    log(`Saved user-stories/${id}-${slug}.md`);

    // 2. Explore the URL
    log('Exploring the application with Playwright (headless)…');
    const exploration = await explorePage(url, { onProgress: (msg) => log(msg) });

    // 3. Ask Claude to generate POM + tests
    const { written, usage } = await generateFiles({
      slug,
      storyId: id,
      title,
      story,
      ac,
      creds,
      exploration,
      onProgress: (msg) => log(msg),
    });

    log('');
    log(`Generated ${written.pages.length} page object(s) and ${written.tests.length} test file(s).`);
    log(`Tokens — input: ${usage.input_tokens}, output: ${usage.output_tokens}`);
    log('');
    log('Done. Reload the UI to pick this feature from the dropdown, then Run Tests.');

    write({ type: 'result', slug, storyId: id, written, usage });
    write({ type: 'done', ok: true });
    res.end();
  } catch (err) {
    write({ type: 'error', message: String((err && err.message) || err) });
    write({ type: 'done', ok: false });
    res.end();
  }
});

// Generate Allure HTML report (needs Java)
app.post('/api/allure-generate', (req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  const write = (obj) => res.write(JSON.stringify(obj) + '\n');
  write({ type: 'start', cmd: 'npx allure generate allure-results --clean -o allure-report' });

  const proc = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['allure', 'generate', 'allure-results', '--clean', '-o', 'allure-report'],
    { cwd: ROOT, env: process.env, shell: process.platform === 'win32' });

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
  // Newest first
  items.sort((a, b) => b.ts - a.ts);
  res.json(items);
});

app.get('/api/report-status', (_req, res) => {
  res.json({
    playwright: fs.existsSync(path.join(ROOT, 'playwright-report', 'index.html')),
    allure: fs.existsSync(path.join(ROOT, 'allure-report', 'index.html')),
    aiReports: fs.existsSync(path.join(ROOT, 'reports'))
      ? fs.readdirSync(path.join(ROOT, 'reports')).filter((f) => f.endsWith('.md'))
      : [],
  });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`\nAgentic QA Pipeline UI: http://localhost:${PORT}\n`);
});
