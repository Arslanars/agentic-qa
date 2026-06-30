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
    // Skip underscore-prefixed scaffolding/shared dirs (e.g. _shared/, _TEMPLATE
    // folders) — they hold step helpers, not user-facing features.
    const isFeatureDir = (name) => !name.startsWith('_') && !name.startsWith('.');
    // 1) Classic POM tests
    if (fs.existsSync(CFG_PATHS.tests)) {
      for (const name of fs.readdirSync(CFG_PATHS.tests)) {
        if (!isFeatureDir(name)) continue;
        const stat = fs.statSync(path.join(CFG_PATHS.tests, name), { throwIfNoEntry: false });
        if (!stat || !stat.isDirectory()) continue;
        let specs = 0;
        try { specs = fs.readdirSync(path.join(CFG_PATHS.tests, name)).filter((f) => f.endsWith('.spec.ts')).length; } catch (_) {}
        featureMap.set(name, { name, specs, features: 0 });
      }
    }
    // 2) Gherkin .feature files — only count folders that contain a real
    // .feature file. _shared/ has step defs only, so it's filtered out by
    // both the underscore guard AND the zero-feature-file guard.
    const featuresDir = path.join(ROOT, 'features');
    if (fs.existsSync(featuresDir)) {
      for (const name of fs.readdirSync(featuresDir)) {
        if (!isFeatureDir(name)) continue;
        const stat = fs.statSync(path.join(featuresDir, name), { throwIfNoEntry: false });
        if (!stat || !stat.isDirectory()) continue;
        let count = 0;
        try { count = fs.readdirSync(path.join(featuresDir, name)).filter((f) => f.endsWith('.feature')).length; } catch (_) {}
        if (count === 0 && !featureMap.has(name)) continue; // skip folders with no scenarios
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

// Same idea for the `claude` test-generation process. Mutually exclusive
// with activeRun — the UI guards against starting one while the other runs.
let activeGenerate = null;

// Stop the active Playwright run, if any. Returns 204 if a kill was sent,
// 404 if nothing was running.
app.post('/api/abort', (_req, res) => {
  if (activeRun && activeRun.proc && !activeRun.proc.killed) {
    killProcessTree(activeRun.proc);
    return res.status(204).end();
  }
  res.status(404).json({ error: 'no active run' });
});

// Stop the active claude test-generation process. Separate endpoint so the
// frontend can route Stop intelligently (whichever is in flight).
app.post('/api/abort-generate', (_req, res) => {
  if (activeGenerate && activeGenerate.proc && !activeGenerate.proc.killed) {
    killProcessTree(activeGenerate.proc);
    return res.status(204).end();
  }
  res.status(404).json({ error: 'no active generate' });
});

// Detect whether `claude` CLI is on PATH. Cached after first check — PATH
// doesn't change for the life of this process, so we don't need to keep
// re-probing. The frontend hits /api/generate-status on load to decide
// whether to enable the auto-generate flow vs. fall back to copy-prompt.
let claudeCliCache = null;
function checkClaudeCli() {
  if (claudeCliCache !== null) return Promise.resolve(claudeCliCache);
  return new Promise((resolve) => {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    const proc = spawn(probe, ['claude'], { shell: process.platform === 'win32' });
    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.on('close', (code) => {
      claudeCliCache = code === 0 && stdout.trim().length > 0;
      resolve(claudeCliCache);
    });
    proc.on('error', () => { claudeCliCache = false; resolve(false); });
  });
}

app.get('/api/generate-status', async (_req, res) => {
  const available = await checkClaudeCli();
  res.json({ available, running: !!activeGenerate });
});

// Drive `claude --print` with a prompt piped via stdin. Streams NDJSON the
// same way /api/run does so the existing log viewer can render it without
// changes. We DON'T put the prompt on argv — that would force us to shell-
// quote arbitrary multiline text; stdin sidesteps the issue entirely.
app.post('/api/generate-tests', async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 20) {
    return res.status(400).json({ error: 'prompt must be a non-empty string of at least 20 chars' });
  }
  if (prompt.length > 100_000) {
    return res.status(413).json({ error: 'prompt too large (>100KB)' });
  }
  const claudeOk = await checkClaudeCli();
  if (!claudeOk) {
    return res.status(501).json({
      error: 'claude CLI not found on PATH. Install Claude Code (https://docs.claude.com/en/docs/claude-code) and ensure `claude` is on PATH, or use the copy-prompt fallback below.'
    });
  }
  if (activeGenerate) {
    return res.status(409).json({ error: 'a test-generation is already in progress; abort or wait' });
  }
  if (activeRun) {
    return res.status(409).json({ error: 'a test run is in progress — stop it before generating new tests' });
  }
  await streamClaudeWithPrompt(res, prompt);
});

// Heal a failing test by handing claude its failure context (error message,
// screenshot path, feature/steps/POM file paths) and asking it to diagnose
// + propose a fix. Reuses the streamClaudeWithPrompt helper so the wire
// protocol matches /api/generate-tests; the only thing different is how the
// prompt gets built.
app.post('/api/heal', async (req, res) => {
  const { feature, fullTitle, file, line, errorMessage, errorStack, screenshot, category } = req.body || {};
  if (!feature || !isSafeName(feature)) {
    return res.status(400).json({ error: `feature must match ${SAFE_NAME_RE}` });
  }
  if (!fullTitle || typeof fullTitle !== 'string') {
    return res.status(400).json({ error: 'fullTitle is required' });
  }
  if (!errorMessage || typeof errorMessage !== 'string') {
    return res.status(400).json({ error: 'errorMessage is required' });
  }
  const claudeOk = await checkClaudeCli();
  if (!claudeOk) {
    return res.status(501).json({ error: 'claude CLI not found on PATH.' });
  }
  if (activeGenerate) return res.status(409).json({ error: 'a Claude job is already in progress' });
  if (activeRun) return res.status(409).json({ error: 'a test run is in progress — stop it before healing' });

  const featureDir = path.join(ROOT, 'features', feature);
  const featureFile = fs.existsSync(featureDir)
    ? fs.readdirSync(featureDir).filter((f) => f.endsWith('.feature') && !f.startsWith('_'))[0]
    : null;
  const stepsFile = fs.existsSync(featureDir)
    ? fs.readdirSync(featureDir).filter((f) => f.endsWith('.steps.ts'))[0]
    : null;
  const pageDir = path.join(ROOT, 'pages', feature);
  const pomFiles = fs.existsSync(pageDir)
    ? fs.readdirSync(pageDir).filter((f) => f.endsWith('.ts'))
    : [];

  const prompt = `A Playwright BDD test just failed. Diagnose the root cause and fix it.

FAILED TEST:
- Feature folder: features/${feature}/
- Spec path:      ${file || '(unknown)'}
- Test title:     ${fullTitle}
- Status:         ${category === 'broken' ? 'BROKEN (timeout / interrupted)' : 'FAILED (assertion)'}
${screenshot ? `- Screenshot:     ${screenshot}` : ''}

ERROR MESSAGE:
${String(errorMessage).slice(0, 4000)}

${errorStack ? `STACK:\n${String(errorStack).slice(0, 4000)}\n\n` : ''}EXISTING FILES TO INSPECT (read these first):
- Feature:   features/${feature}/${featureFile || '<missing>'}
- Step defs: features/${feature}/${stepsFile || '<missing>'}
- POM:       pages/${feature}/${pomFiles.join(', pages/' + feature + '/') || '<missing>'}

INSTRUCTIONS FOR CLAUDE:
1. Read the screenshot if available — visual cues often tell you what the app actually rendered vs what the test expected.
2. Read the feature, step definitions, and POM files for the failing scenario.
3. Diagnose the failure: is it a stale selector? Missing wait? Timing race? Real product regression? AC mismatch?
4. Apply the SMALLEST fix that addresses the root cause. Do NOT broadly rewrite passing scenarios.
   - For timeouts: tighten waits / add expectLoaded / use expect.poll — do not just bump timeout to mask flake.
   - For selector breakage: locate the actual element in the screenshot/snapshot and update the POM selector.
   - For assertion mismatch: confirm the AC; if the app changed, update the assertion; if the test was wrong, fix the test.
5. Run \`npx bddgen\` after edits so the compiled spec reflects feature changes.
6. Do NOT delete tests to make the suite green. If a failure represents a real bug, document it in a comment instead.
7. Stream short status updates so the UI shows progress.`;

  await streamClaudeWithPrompt(res, prompt);
});

// Shared executor: spawn `claude --print --verbose --output-format stream-json
// --dangerously-skip-permissions`, feed `prompt` via stdin, and stream the
// JSONL events back to the client as formatted NDJSON log lines. Owns the
// activeGenerate slot so concurrency guards are consistent across callers.
async function streamClaudeWithPrompt(res, prompt) {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.on('error', () => {});
  const write = makeSafeWrite(res);

  const args = ['--print', '--verbose', '--output-format', 'stream-json', '--dangerously-skip-permissions'];
  write({ type: 'start', cmd: `claude ${args.join(' ')}  (prompt via stdin, ${prompt.length} chars)`, cwd: ROOT });

  const cmd = process.platform === 'win32' ? 'claude.cmd' : 'claude';
  let proc;
  try {
    proc = spawn(cmd, args, {
      cwd: ROOT,
      env: process.env,
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    write({ type: 'log', stream: 'stderr', text: `[ui] claude spawn failed: ${err.message}\n` });
    write({ type: 'done', exitCode: 1 });
    res.end();
    return;
  }

  activeGenerate = { proc, startedAt: Date.now() };

  try {
    proc.stdin.on('error', (err) => {
      write({ type: 'log', stream: 'stderr', text: `[ui] stdin write error: ${err.message}\n` });
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
  } catch (err) {
    write({ type: 'log', stream: 'stderr', text: `[ui] failed to feed prompt to claude: ${err.message}\n` });
  }

  let finished = false;
  res.on('close', () => {
    if (!finished && proc && !proc.killed) killProcessTree(proc);
  });

  let lineBuf = '';
  proc.stdout.on('data', (d) => {
    lineBuf += d.toString();
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop();
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); }
      catch {
        write({ type: 'log', stream: 'stdout', text: raw + '\n' });
        continue;
      }
      const formatted = formatClaudeStreamEvent(event);
      if (formatted) write({ type: 'log', stream: 'stdout', text: formatted + '\n' });
    }
  });
  proc.stderr.on('data', (d) => write({ type: 'log', stream: 'stderr', text: d.toString() }));
  proc.on('error', (err) => {
    if (finished) return;
    finished = true;
    activeGenerate = null;
    write({ type: 'log', stream: 'stderr', text: `[ui] claude process error: ${err.message}\n` });
    write({ type: 'done', exitCode: 1 });
    res.end();
  });
  proc.on('close', (code) => {
    if (finished) return;
    finished = true;
    activeGenerate = null;
    if (lineBuf.trim()) {
      write({ type: 'log', stream: 'stdout', text: lineBuf + '\n' });
      lineBuf = '';
    }
    write({ type: 'done', exitCode: code == null ? 1 : code });
    res.end();
  });
}

// Turn one stream-json event from `claude --print --output-format stream-json`
// into a short human-readable line for the log viewer. Returns null to drop
// the event (e.g. initialization noise). Truncates large tool inputs so a
// 5KB Write content blob doesn't flood the log.
function formatClaudeStreamEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const trunc = (s, n = 120) => {
    const str = String(s ?? '');
    return str.length > n ? str.slice(0, n) + '…' : str;
  };
  const relPath = (p) => {
    if (!p) return '';
    const s = String(p).replace(/\\/g, '/');
    const rootNorm = ROOT.replace(/\\/g, '/');
    return s.startsWith(rootNorm) ? s.slice(rootNorm.length).replace(/^\//, '') : s;
  };

  // Init / system messages — quiet by default; surface only sub-types we
  // care about (e.g. errors, mode changes).
  if (event.type === 'system') {
    if (event.subtype === 'init') {
      const sid = event.session_id ? event.session_id.slice(0, 8) : '';
      return `[claude] session ${sid} — model ${event.model || '?'}, tools=${(event.tools || []).length}`;
    }
    return null;
  }

  // Assistant turn — either prose text or a tool_use block.
  if (event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
    const lines = [];
    for (const c of event.message.content) {
      if (c.type === 'text' && c.text) {
        const text = c.text.trim();
        if (text) lines.push(`[claude] ${text}`);
      } else if (c.type === 'tool_use') {
        const name = c.name || 'Tool';
        const inp = c.input || {};
        let summary;
        switch (name) {
          case 'Read':       summary = `Read ${relPath(inp.file_path)}${inp.offset || inp.limit ? ` (lines ${inp.offset || 1}-${(inp.offset || 1) + (inp.limit || 0)})` : ''}`; break;
          case 'Write':      summary = `Write ${relPath(inp.file_path)} (${(inp.content || '').length} chars)`; break;
          case 'Edit':       summary = `Edit ${relPath(inp.file_path)}`; break;
          case 'MultiEdit':  summary = `MultiEdit ${relPath(inp.file_path)} (${(inp.edits || []).length} edits)`; break;
          case 'Bash':       summary = `Bash: ${trunc(inp.command, 100)}`; break;
          case 'Glob':       summary = `Glob: ${inp.pattern || ''}${inp.path ? ' in ' + relPath(inp.path) : ''}`; break;
          case 'Grep':       summary = `Grep: ${inp.pattern || ''}${inp.path ? ' in ' + relPath(inp.path) : ''}`; break;
          case 'TodoWrite':  summary = `TodoWrite (${(inp.todos || []).length} items)`; break;
          case 'WebFetch':   summary = `WebFetch: ${trunc(inp.url, 80)}`; break;
          case 'WebSearch':  summary = `WebSearch: ${trunc(inp.query, 80)}`; break;
          case 'Task':       summary = `Task → ${inp.subagent_type || 'agent'}: ${trunc(inp.description, 80)}`; break;
          default:           summary = `${name}(${trunc(JSON.stringify(inp), 80)})`;
        }
        lines.push(`→ ${summary}`);
      }
    }
    return lines.length > 0 ? lines.join('\n') : null;
  }

  // Tool result (returned from "user" turn). Usually verbose; show only a
  // one-line summary so the log doesn't get drowned in file contents.
  if (event.type === 'user' && event.message && Array.isArray(event.message.content)) {
    const lines = [];
    for (const c of event.message.content) {
      if (c.type === 'tool_result') {
        const isErr = c.is_error === true;
        const content = Array.isArray(c.content)
          ? c.content.map((x) => (typeof x === 'string' ? x : (x.text || ''))).join(' ')
          : (c.content || '');
        const first = String(content).split('\n')[0];
        lines.push(`   ${isErr ? '⚠ error' : 'ok'}${first ? `: ${trunc(first, 100)}` : ''}`);
      }
    }
    return lines.length > 0 ? lines.join('\n') : null;
  }

  // Final result message — duration + cost + any error.
  if (event.type === 'result') {
    const dur = event.duration_ms ? `${(event.duration_ms / 1000).toFixed(1)}s` : '';
    const apiDur = event.duration_api_ms ? ` (api ${(event.duration_api_ms / 1000).toFixed(1)}s)` : '';
    const turns = event.num_turns != null ? ` · ${event.num_turns} turns` : '';
    const cost = event.total_cost_usd != null ? ` · $${event.total_cost_usd.toFixed(4)}` : '';
    const tag = event.is_error || event.subtype === 'error' ? '✗ FAILED' : '✓ done';
    return `[claude] ${tag} — ${dur}${apiDur}${turns}${cost}`;
  }

  return null;
}

// Append one summary line per completed run to test-results/history.jsonl
// so the UI can render a sparkline trend. Capped at HISTORY_MAX rows; older
// entries are rotated out so the file never grows unbounded.
const HISTORY_MAX = 200;
function recordRunHistory({ feature, project, lastFailed } = {}) {
  const jsonPath = path.join(CFG_PATHS.testResults, 'results.json');
  if (!fs.existsSync(jsonPath)) return;
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  let passed = 0, failed = 0, broken = 0, skipped = 0, flaky = 0, total = 0;
  const visit = (suite) => {
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        const last = (test.results || []).slice(-1)[0];
        if (!last) continue;
        total++;
        let st = last.status;
        if (test.status === 'flaky') st = 'flaky';
        if (st === 'passed') passed++;
        else if (st === 'failed') failed++;
        else if (st === 'timedOut' || st === 'interrupted') broken++;
        else if (st === 'flaky') flaky++;
        else if (st === 'skipped') skipped++;
      }
    }
    for (const c of suite.suites || []) visit(c);
  };
  for (const s of data.suites || []) visit(s);

  // When project is empty, Playwright ran every configured project (the
  // matrix run). Record it as 'all' so the ETA lookup can distinguish a
  // matrix run from a single-browser run.
  const row = {
    ts: data.stats?.startTime || new Date().toISOString(),
    duration: data.stats?.duration || 0,
    feature: feature || 'all',
    project: project || 'all',
    lastFailed: !!lastFailed,
    total, passed, failed, broken, skipped, flaky,
  };

  // Persisted under reports/ — test-results/ is wiped by Playwright at the
  // start of every run, which would wipe our trend data with it.
  const historyPath = path.join(CFG_PATHS.reports, 'history.jsonl');
  let lines = [];
  if (fs.existsSync(historyPath)) {
    try {
      lines = fs.readFileSync(historyPath, 'utf8').split('\n').filter((l) => l.trim());
    } catch (_) { lines = []; }
  }
  lines.push(JSON.stringify(row));
  if (lines.length > HISTORY_MAX) lines = lines.slice(-HISTORY_MAX);
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.writeFileSync(historyPath, lines.join('\n') + '\n');
}

// Per-test history: one line per test per run. Separate from run history
// (which is one line per run) so the schemas stay flat and append-only.
// Stored under reports/ for the same reason as run history.
const TEST_HISTORY_MAX = 5000; // ~200 runs × 25 tests; keeps the file small
function recordTestHistory({ feature, project } = {}) {
  const jsonPath = path.join(CFG_PATHS.testResults, 'results.json');
  if (!fs.existsSync(jsonPath)) return;
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const ts = data.stats?.startTime || new Date().toISOString();
  const rows = [];
  const visit = (suite, parentTitles = []) => {
    const titles = suite.title ? [...parentTitles, suite.title] : parentTitles;
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        const last = (test.results || []).slice(-1)[0];
        if (!last) continue;
        let status = last.status;
        if (test.status === 'flaky') status = 'flaky';
        const fullTitle = [...titles, spec.title].filter(Boolean).join(' › ');
        const featureFromFile = (suite.file || spec.file || '')
          .replace(/\\/g, '/')
          .replace(/^(?:.*\/)?\.?features-gen\/features\//, '')
          .replace(/^(?:.*\/)?tests\//, '')
          .split('/')[0] || feature || 'unknown';
        rows.push({
          ts,
          feature: featureFromFile,
          project: test.projectName || project || 'chromium',
          fullTitle,
          spec: spec.title,
          status,
          duration: last.duration || 0,
        });
      }
    }
    for (const c of suite.suites || []) visit(c, titles);
  };
  for (const s of data.suites || []) visit(s);
  if (rows.length === 0) return;

  const historyPath = path.join(CFG_PATHS.reports, 'test-history.jsonl');
  let lines = [];
  if (fs.existsSync(historyPath)) {
    try { lines = fs.readFileSync(historyPath, 'utf8').split('\n').filter((l) => l.trim()); } catch (_) { lines = []; }
  }
  for (const row of rows) lines.push(JSON.stringify(row));
  if (lines.length > TEST_HISTORY_MAX) lines = lines.slice(-TEST_HISTORY_MAX);
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.writeFileSync(historyPath, lines.join('\n') + '\n');
}

// Coverage-gap detector: cross-reference the ACs in a story with the
// scenarios in its .feature file. The project's convention is that scenario
// names start with `AC<n>-` (AC1-POS-01, AC2-NEG-03, etc.) — so AC<n> is
// covered if any scenario starts with `AC<n>-`. Returns a per-AC list with
// covered/uncovered status + which scenarios cover each AC.
app.get('/api/coverage-gaps', (req, res) => {
  const feature = String(req.query.feature || '').trim();
  if (!feature || !isSafeName(feature)) {
    return res.status(400).json({ error: `feature must match ${SAFE_NAME_RE}` });
  }
  try {
    // Locate the user-story file. Convention: <storyId>-<feature>.md.
    const storiesDir = CFG_PATHS.stories;
    let storyFile = null;
    if (fs.existsSync(storiesDir)) {
      const matches = fs.readdirSync(storiesDir).filter((f) =>
        f.toLowerCase().endsWith(`-${feature.toLowerCase()}.md`) && !f.startsWith('_')
      );
      if (matches.length > 0) storyFile = matches[0];
    }
    // Locate the .feature file.
    const featureDir = path.join(ROOT, 'features', feature);
    let featureFile = null;
    if (fs.existsSync(featureDir)) {
      const matches = fs.readdirSync(featureDir).filter((f) => f.endsWith('.feature') && !f.startsWith('_'));
      if (matches.length > 0) featureFile = matches[0];
    }
    if (!storyFile && !featureFile) {
      return res.status(404).json({ error: `no user-story or feature file for "${feature}"` });
    }

    // Extract ACs from the user-story markdown. The convention varies — some
    // stories use a bare "AC1:" line; the canonical template uses heading
    // form "### AC1: ...". Accept both, plus the dotted/dashed variants
    // ("AC 1.", "AC1.", "AC1 -").
    const acs = [];
    if (storyFile) {
      const md = fs.readFileSync(path.join(storiesDir, storyFile), 'utf8');
      const acRe = /^(?:#{1,6}\s+|\s*[-*]\s+|\s*)AC\s*(\d+)\s*[:.\-)]\s*(.+?)\s*$/gim;
      let m;
      const seen = new Set();
      while ((m = acRe.exec(md)) !== null) {
        const id = parseInt(m[1], 10);
        if (seen.has(id)) continue;
        seen.add(id);
        acs.push({ id, text: m[2].trim().slice(0, 240) });
      }
    }
    acs.sort((a, b) => a.id - b.id);

    // Extract scenarios from the .feature file. Scenario names follow
    // "Scenario: <name>" or "Scenario Outline: <name>".
    const scenarios = [];
    if (featureFile) {
      const txt = fs.readFileSync(path.join(featureDir, featureFile), 'utf8');
      const scRe = /^\s*Scenario(?:\s+Outline)?\s*:\s*(.+?)\s*$/gim;
      let m;
      while ((m = scRe.exec(txt)) !== null) {
        const title = m[1].trim();
        const acMatch = title.match(/^AC(\d+)/i);
        scenarios.push({ title, acId: acMatch ? parseInt(acMatch[1], 10) : null });
      }
    }

    // Build coverage report — one row per AC + a bucket for orphan scenarios
    // (scenarios that don't match the AC<n>- naming convention).
    const coverage = acs.map((ac) => {
      const matched = scenarios.filter((s) => s.acId === ac.id).map((s) => s.title);
      return { id: ac.id, text: ac.text, covered: matched.length > 0, scenarios: matched };
    });
    const orphanScenarios = scenarios.filter((s) => s.acId === null).map((s) => s.title);
    const covered = coverage.filter((c) => c.covered).length;
    const total = coverage.length;
    res.json({
      feature,
      storyFile: storyFile ? `user-stories/${storyFile}` : null,
      featureFile: featureFile ? `features/${feature}/${featureFile}` : null,
      coverage,
      orphanScenarios,
      summary: {
        totalAcs: total,
        coveredAcs: covered,
        uncoveredAcs: total - covered,
        coverageRate: total > 0 ? Number((covered / total).toFixed(3)) : null,
        totalScenarios: scenarios.length,
        orphanCount: orphanScenarios.length,
      },
    });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message) });
  }
});

// Detect flaky tests from per-test history. A test is FLAKY if, over the last
// `window` runs of that test, its outcome flipped between pass and non-pass
// at least `minFlips` times AND pass-rate is strictly between 0% and 100%
// (so consistently-failing tests aren't mislabeled as flaky — those are real
// failures, not flake).
app.get('/api/flaky-tests', (req, res) => {
  try {
    const windowSize = Math.min(Math.max(parseInt(req.query.window, 10) || 20, 3), 200);
    const minFlips = Math.max(parseInt(req.query.minFlips, 10) || 2, 1);
    const historyPath = path.join(CFG_PATHS.reports, 'test-history.jsonl');
    if (!fs.existsSync(historyPath)) return res.json({ window: windowSize, tests: [] });
    const lines = fs.readFileSync(historyPath, 'utf8').split('\n').filter((l) => l.trim());
    const entries = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

    // Group by (feature, project, fullTitle) — the unique key for a test instance
    const groups = new Map();
    for (const e of entries) {
      const key = `${e.feature}|${e.project}|${e.fullTitle}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }

    const flaky = [];
    for (const [key, runs] of groups) {
      // Keep the last N runs only (chronological by ts; jsonl is append-only
      // so file order ≈ chronological, but sort defensively).
      runs.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
      const window = runs.slice(-windowSize).filter((r) => r.status !== 'skipped');
      if (window.length < 3) continue; // need enough samples to be meaningful

      // Map every outcome to a binary pass/fail so flake counts what users care
      // about: a test that flips between green and not-green. "flaky" status
      // from Playwright (passed-after-retry) counts as a flip event itself.
      const normalized = window.map((r) => r.status === 'passed' ? 'pass' : 'fail');
      let flips = 0;
      for (let i = 1; i < normalized.length; i++) {
        if (normalized[i] !== normalized[i - 1]) flips++;
      }
      const passes = window.filter((r) => r.status === 'passed').length;
      const passRate = passes / window.length;
      const flakyStatusCount = window.filter((r) => r.status === 'flaky').length;

      // Real flaky tests: at least minFlips status flips AND pass-rate not 0 or 1.
      // OR: Playwright already marked it flaky at least once.
      if ((flips >= minFlips && passRate > 0 && passRate < 1) || flakyStatusCount > 0) {
        const last = runs[runs.length - 1];
        flaky.push({
          fullTitle: last.fullTitle,
          spec: last.spec,
          feature: last.feature,
          project: last.project,
          totalRuns: window.length,
          passes,
          fails: window.length - passes,
          passRate: Number(passRate.toFixed(3)),
          flipCount: flips,
          lastStatus: last.status,
          playwrightFlakyCount: flakyStatusCount,
        });
      }
    }

    // Sort: least stable first (lower passRate → higher concern).
    flaky.sort((a, b) => a.passRate - b.passRate || b.flipCount - a.flipCount);
    res.json({ window: windowSize, minFlips, tests: flaky });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message) });
  }
});

// Return the last N run summaries (default 30) for the status-bar sparkline.
// Each entry: { ts, total, passed, failed, broken, skipped, flaky, duration, feature, project }
app.get('/api/history', (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), HISTORY_MAX);
    const historyPath = path.join(CFG_PATHS.reports, 'history.jsonl');
    if (!fs.existsSync(historyPath)) return res.json({ runs: [] });
    const lines = fs.readFileSync(historyPath, 'utf8').split('\n').filter((l) => l.trim());
    const runs = lines.slice(-limit).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    res.json({ runs });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message) });
  }
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
          // Category lets the UI label each card "failed" (assertion) vs
          // "broken" (timeout / interrupted). Same set as report-writer.js.
          const category =
            last.status === 'failed' ? 'failed' :
            (last.status === 'timedOut' || last.status === 'interrupted') ? 'broken' :
            last.status;
          failures.push({
            title: spec.title,
            fullTitle: [...titles, spec.title].filter(Boolean).join(' › '),
            file: (suite.file || spec.file || '').replace(/\\/g, '/'),
            line: spec.line,
            project: test.projectName,
            duration: last.duration,
            status: last.status,
            category,
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
  // feature, refer to a real folder under features/ or tests/.
  if (feature !== undefined && feature !== null && feature !== '') {
    if (!isSafeName(feature)) {
      return res.status(400).json({ error: `feature must match ${SAFE_NAME_RE} (got "${feature}")` });
    }
    const inFeatures = fs.existsSync(path.join(ROOT, 'features', feature));
    const inTests = fs.existsSync(path.join(CFG_PATHS.tests, feature));
    if (!inFeatures && !inTests) {
      return res.status(404).json({ error: `feature "${feature}" does not exist under features/ or tests/` });
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

  const args = ['playwright', 'test'];
  // --last-failed runs only the tests that failed in the previous run.
  // Playwright doesn't combine it with a path filter.
  if (lastFailed) {
    args.push('--last-failed');
  } else if (feature) {
    // Specific feature picked → filter the BDD compiled tests by feature dir.
    args.push(`.features-gen/features/${feature}/`);
  }
  if (project) args.push(`--project=${project}`);
  // Default-skip @destructive tag (e.g. signup AC1/AC2 that creates real
  // tenants on prod). Override with `?destructive=1` in the request.
  if (!req.body?.destructive) args.push('--grep-invert=@destructive');
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

    // Append one summary row to history.jsonl so the status-bar sparkline
    // can show a 30-run trend. Best-effort; never crashes the response.
    try {
      recordRunHistory({ feature: feature || null, project: project || null, lastFailed: !!lastFailed });
    } catch (err) {
      write({ type: 'log', stream: 'stderr', text: `[history] failed to record: ${err.message}\n` });
    }

    // Append one row per test to test-history.jsonl so we can detect flakiness
    // across runs. Stored separately from the run summary so each file stays
    // simple and append-only. Best-effort.
    try {
      recordTestHistory({ feature: feature || null, project: project || null });
    } catch (err) {
      write({ type: 'log', stream: 'stderr', text: `[history] failed to record per-test history: ${err.message}\n` });
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
