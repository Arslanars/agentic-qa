// Simple Express server that powers the UI at http://localhost:3001
// - Lists features in tests/
// - Saves a user-story file
// - Runs Playwright tests in headed mode and streams output as NDJSON
// - Rebuilds the Allure HTML report after every run
//
// No paid-API features. POM + spec generation and self-healing are done via
// the Claude Code path (see QAEnd2EndPromptFile.md), or by hand-authoring.

const express = require('express');
const { spawn, exec, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { renderReport } = require('./report-renderer');
const { writeRunReports, featuresFromLastRun, reportMatchesFeature } = require('./report-writer');
const { ALL_PROJECTS, projectNames, desktopProjectNames } = require('./projects');
const { writeTestCasesExcel } = require('./excel-writer');
// Security / performance / API-test engines (dependency-free; also usable
// headless via bin/qa-scan.js). Wired to the endpoints below + UI panels.
const security = require('../lib/security');
const perfEngine = require('../lib/perf/lighthouse');
const apiTesting = require('../lib/api-testing/runner');
const explore = require('../lib/explore');
const stepIndex = require('../lib/steps');

// Model for short, mechanical Claude jobs (converting a recording, explaining a
// failure). These do not need a frontier model and latency is what you feel, so
// a fast one is pinned. Set AGENTIC_QA_CLAUDE_MODEL to override, or to the
// literal "default" to pass no --model flag at all and keep the CLI's own
// setting. Generation, healing and review are deliberately NOT pinned.
const FAST_MODEL = process.env.AGENTIC_QA_CLAUDE_MODEL || 'haiku';

/** Append --model only when a fast model is wanted and not disabled. */
function withFastModel(args) {
  if (!FAST_MODEL || FAST_MODEL === 'default') return args;
  return args.concat(['--model', FAST_MODEL]);
}

/**
 * Tags declared by a feature's .feature file. Needed because step definitions
 * are tag-scoped — the set of phrases available to a scenario depends entirely
 * on its tags, so "does this step already exist?" is unanswerable without them.
 */
function featureTagsFor(feature) {
  if (!feature || !isSafeName(feature)) return [];
  const dir = path.join(ROOT, 'features', feature);
  if (!fs.existsSync(dir)) return [];
  try {
    const file = fs.readdirSync(dir).find((f) => f.endsWith('.feature') && !f.startsWith('_'));
    if (!file) return [];
    return stepIndex.featureTags(fs.readFileSync(path.join(dir, file), 'utf8'));
  } catch {
    return [];
  }
}

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

// Playwright only recreates output folders for the tests that ACTUALLY run —
// it never wipes test-results/ as a whole. So per-test artifact folders
// (screenshots, videos, traces) from PREVIOUS runs of OTHER features or
// browsers linger on disk, and the screenshot gallery (which lists everything
// under test-results/) ends up showing stale, cross-feature, cross-browser
// shots — e.g. 42 images for a single 14-scenario login run because 3 browsers'
// worth accumulated. Clear the per-test artifact SUBDIRECTORIES before each run
// so the gallery reflects only the current run. Top-level files are preserved:
// .last-run.json (so --last-failed / "Re-run failed" still works) and
// results.json (consumed afterwards by the report + history writers).
function cleanTestArtifacts(write) {
  try {
    if (!fs.existsSync(CFG_PATHS.testResults)) return;
    let removed = 0;
    for (const name of fs.readdirSync(CFG_PATHS.testResults)) {
      const p = path.join(CFG_PATHS.testResults, name);
      let st;
      try { st = fs.statSync(p); } catch (_) { continue; }
      if (st.isDirectory()) {
        try { fs.rmSync(p, { recursive: true, force: true }); removed++; } catch (_) { /* locked file — skip */ }
      }
    }
    if (removed > 0 && write) {
      write({ type: 'log', stream: 'stdout', text: `[ui] cleared ${removed} stale artifact folder(s) from test-results/ so the gallery shows only this run\n` });
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
  // Compile the .feature files here rather than asking the model to run bddgen
  // itself. Doing it in Node is faster (no extra model turn), deterministic, and
  // cannot be skipped or mis-run. The prompt tells Claude not to run it.
  await streamClaudeWithPrompt(res, prompt, {
    afterSuccess: async (write) => {
      write({ type: 'log', stream: 'stdout', text: '[ui] compiling .feature files (bddgen)…\n' });
      await runBddgen(write);
    },
  });
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

// Spec Doctor — critique a user story for testability BEFORE the user
// commits to a full Generate Tests round-trip. This is the only feature
// that calls claude *synchronously* (no stream) — the response is short,
// the UI shows a small spinner, and we want a clean structured payload
// rather than line-by-line drip.
app.post('/api/critique-spec', async (req, res) => {
  const { url, title, ac, creds, storyId } = req.body || {};
  if (!url || !title || !ac) {
    return res.status(400).json({ error: 'url, title, and ac are required' });
  }
  if ((ac || '').length > 20_000) {
    return res.status(413).json({ error: 'ac is too long (>20KB)' });
  }
  const claudeOk = await checkClaudeCli();
  if (!claudeOk) {
    return res.status(501).json({ error: 'claude CLI not found on PATH' });
  }
  if (activeGenerate) {
    return res.status(409).json({ error: 'another Claude job is in progress' });
  }

  const prompt = `You are a QA lint for user-story acceptance criteria. Score the input ACs against a testability rubric and return STRICT JSON — nothing else, no commentary outside the JSON object.

Rubric (find issues — each issue should target ONE AC):
1. AMBIGUOUS_VERB — uses words like "works correctly", "should be fast", "behaves well" with no measurable assertion.
2. VAGUE_QUANTITY — uses "many", "few", "lots", "some" instead of a specific count/threshold.
3. MISSING_NEGATIVE — describes only the happy path; no negative case (wrong input, error state, denied permission) named for this AC.
4. UNTESTABLE_ASSERTION — the AC's outcome cannot be observed deterministically from the browser (e.g. "the user is happy", "the system is secure").
5. MISSING_PRECONDITION — the AC implies a setup state (logged in, account exists, item in cart) that isn't declared.
6. SCOPE_CREEP — bundles multiple ACs into one (use of "and" linking distinct outcomes).

INPUT
URL: ${url}
${storyId ? `Story ID: ${storyId}\n` : ''}Title: ${title}
${creds ? `Credentials: ${creds}\n` : ''}
Acceptance Criteria:
${ac}

OUTPUT — return EXACTLY this JSON shape (no markdown fences, no preamble, no trailing text):

{
  "issues": [
    {
      "ruleId": "AMBIGUOUS_VERB",
      "severity": "blocker" | "high" | "medium" | "low",
      "acRef": "AC1" | "AC2" | ...,
      "snippet": "the exact AC fragment with the problem",
      "description": "one-sentence explanation of why this is untestable",
      "suggestedRewrite": "a concrete revised AC that is testable, OR null if no clean rewrite"
    }
  ],
  "summary": "one short sentence overall: 'looks solid', 'two AC fragments need tightening', etc."
}

If the spec is clean and passes the rubric, return:
{ "issues": [], "summary": "Spec passes the testability rubric." }

Be strict but fair — flag only real testability problems, not stylistic nits. Maximum 8 issues.`;

  const cmd = process.platform === 'win32' ? 'claude.cmd' : 'claude';
  const args = ['--print', '--dangerously-skip-permissions'];
  let proc;
  try {
    proc = spawn(cmd, args, {
      cwd: ROOT,
      env: process.env,
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    return res.status(500).json({ error: `claude spawn failed: ${err.message}` });
  }
  activeGenerate = { proc, startedAt: Date.now() };

  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (d) => { stdout += d.toString(); });
  proc.stderr.on('data', (d) => { stderr += d.toString(); });

  try {
    proc.stdin.on('error', () => {});
    proc.stdin.write(prompt);
    proc.stdin.end();
  } catch (_) { /* swallow — handled by exit code below */ }

  // Bound the wait so a hung claude doesn't tie up the request indefinitely.
  // Critique should be <30s in practice; 60s is a comfortable ceiling.
  const TIMEOUT_MS = 60_000;
  const timer = setTimeout(() => {
    if (!proc.killed) killProcessTree(proc);
  }, TIMEOUT_MS);

  proc.on('close', (code) => {
    clearTimeout(timer);
    activeGenerate = null;
    // Extract the JSON object from claude's response FIRST — the CLI often
    // prints valid JSON to stdout yet still exits non-zero (post-run warning /
    // telemetry / broken pipe), so a good result shouldn't be discarded over
    // the exit code. Claude usually returns pure JSON but occasionally wraps in
    // ```json fences or adds a preamble; this scan finds the first balanced {…}.
    const parsed = extractJsonObject(stdout);
    if (parsed) {
      return res.json({
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
        summary: parsed.summary || '',
      });
    }
    // No usable output — Claude CLI exiting non-zero with empty stderr AND empty
    // stdout is a classic transient signature (network blip, quota check,
    // session refresh). Give an actionable message instead of a cryptic code.
    const trimmedErr = stderr.trim();
    const transient = code === 1 && trimmedErr.length === 0 && stdout.trim().length === 0;
    return res.status(502).json({
      error: transient
        ? 'Claude CLI returned nothing (transient failure). Try again — it usually works on retry.'
        : `claude exited ${code}${trimmedErr ? ': ' + trimmedErr.slice(0, 400) : ' — could not parse a response'}`,
      stderr: stderr.slice(0, 2000),
      rawPreview: stdout.slice(0, 500),
      transient,
    });
  });
  proc.on('error', (err) => {
    clearTimeout(timer);
    activeGenerate = null;
    res.status(500).json({ error: `claude error: ${err.message}` });
  });
});

// Walk a string and return the first balanced {…} block parsed as JSON.
// Tolerates ```json … ``` fences + preamble + trailing prose. Returns null
// if no parseable object is found.
function extractJsonObject(s) {
  if (!s) return null;
  // Strip markdown fences first — common claude habit.
  let txt = s.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1');
  // Find first balanced { … } via simple depth counting (good enough for
  // claude's outputs which are well-formed JSON without unbalanced braces in
  // string values that would confuse this naive scan in practice).
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try { return JSON.parse(txt.slice(start, i + 1)); }
        catch { return null; }
      }
    }
  }
  return null;
}

// Shared executor: spawn `claude --print --verbose --output-format stream-json
// --dangerously-skip-permissions`, feed `prompt` via stdin, and stream the
// JSONL events back to the client as formatted NDJSON log lines. Owns the
// activeGenerate slot so concurrency guards are consistent across callers.
/**
 * @param opts.afterSuccess optional async (write) => void, awaited after Claude
 *   exits 0 and before the stream closes. Use it for deterministic follow-up
 *   work — compiling BDD, regenerating reports — that would otherwise cost the
 *   model a tool-call round trip to perform itself.
 */
async function streamClaudeWithPrompt(res, prompt, opts = {}) {
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
  proc.on('close', async (code) => {
    if (finished) return;
    finished = true;
    activeGenerate = null;
    if (lineBuf.trim()) {
      write({ type: 'log', stream: 'stdout', text: lineBuf + '\n' });
      lineBuf = '';
    }
    // Deterministic follow-up work runs here, in Node — not as another model
    // turn. Only on success: there is nothing to compile after a failed run.
    if (code === 0 && typeof opts.afterSuccess === 'function') {
      try {
        await opts.afterSuccess(write);
      } catch (err) {
        write({ type: 'log', stream: 'stderr', text: `[ui] post-step failed: ${err && err.message}\n` });
      }
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
// Playwright's JSON reporter sometimes prefixes a test's title chain with the
// spec FILE PATH as a suite title (e.g. ".features-gen/features/x/x.feature:7").
// Strip any path-like segment so a test's history key stays stable across runs —
// otherwise the same test fragments into several keys and reads as flaky.
function cleanTestTitle(ft) {
  return String(ft || '')
    .split('›')
    .map((s) => s.trim())
    .filter((s) => s && !/[\\/]/.test(s) && !/\.(feature|spec\.[jt]s|[jt]s)(?::\d+)?$/i.test(s))
    .join(' › ');
}

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
        const fullTitle = cleanTestTitle([...titles, spec.title].filter(Boolean).join(' › '));
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

// ---- Coverage Gap Closer -----------------------------------------------
// Given an uncovered AC (feature slug + AC id + AC text), have claude draft
// ONE Gherkin scenario that covers it, reusing existing step phrasings from
// the feature's .steps.ts where they match. Synchronous call — small
// structured JSON response the UI shows in a preview panel. The user then
// accepts to /api/recorder/append (existing) + optionally chains into
// /api/scaffold-missing-steps (existing) for any newly-invented steps.
app.post('/api/coverage/draft-scenario', async (req, res) => {
  const { feature, acId, acText } = req.body || {};
  if (!feature || !isSafeName(feature)) {
    return res.status(400).json({ error: `feature must match ${SAFE_NAME_RE}` });
  }
  const acN = parseInt(acId, 10);
  if (!Number.isInteger(acN) || acN < 1 || acN > 999) {
    return res.status(400).json({ error: 'acId must be a positive integer' });
  }
  if (!acText || typeof acText !== 'string' || acText.trim().length < 3) {
    return res.status(400).json({ error: 'acText is required' });
  }
  if (String(acText).length > 2000) {
    return res.status(413).json({ error: 'acText too long' });
  }

  const claudeOk = await checkClaudeCli();
  if (!claudeOk) return res.status(501).json({ error: 'claude CLI not found on PATH' });
  if (activeGenerate) return res.status(409).json({ error: 'another Claude job is in progress' });

  // Gather context: existing steps + POMs + one sample scenario from the
  // feature file so claude can match the project's tone/style.
  let existingSteps = '';
  let sampleScenario = '';
  let existingFeatureFile = '';
  const featureDir = path.join(ROOT, 'features', feature);
  if (fs.existsSync(featureDir)) {
    const stepsFile = fs.readdirSync(featureDir).find((f) => f.endsWith('.steps.ts'));
    if (stepsFile) {
      try { existingSteps = fs.readFileSync(path.join(featureDir, stepsFile), 'utf8').slice(0, 20000); } catch (_) {}
    }
    const featureFile = fs.readdirSync(featureDir).find((f) => f.endsWith('.feature') && !f.startsWith('_'));
    if (featureFile) {
      existingFeatureFile = featureFile;
      try {
        const txt = fs.readFileSync(path.join(featureDir, featureFile), 'utf8');
        // Grab the first non-Background Scenario as a style sample
        const m = txt.match(/Scenario(?:\s+Outline)?:[\s\S]*?(?=\n\s*Scenario|\n\s*Feature|$)/);
        sampleScenario = m ? m[0].slice(0, 1500) : '';
      } catch (_) {}
    }
  }

  let pomContent = '';
  const pomDir = path.join(ROOT, 'pages', feature);
  if (fs.existsSync(pomDir)) {
    const pomFiles = fs.readdirSync(pomDir).filter((f) => f.endsWith('.ts'));
    for (const f of pomFiles) {
      pomContent += `\n// ----- pages/${feature}/${f} -----\n${fs.readFileSync(path.join(pomDir, f), 'utf8').slice(0, 4000)}\n`;
    }
  }

  const prompt = `Draft ONE Gherkin Scenario block that covers this acceptance criterion. Return STRICT JSON, no markdown fences.

TARGET AC:
  ${acId}: ${acText}

RULES for the scenario name — the FIRST scenario naming rule matters most:
1. MUST start with "${acId}-" so the framework's coverage detector links it back to this AC.
2. Add a POS or NEG suffix + a two-digit number:
     - POS-01, POS-02 for happy paths
     - NEG-01, NEG-02 for error / rejection paths
3. Then a "—" separator and a short human-readable description.
   Example valid names: "${acId}-POS-01 — successful login with valid credentials"

EXISTING STEP DEFINITIONS (features/${feature}/${feature}.steps.ts — REUSE these phrasings when they fit; only invent new steps when nothing matches):
\`\`\`typescript
${existingSteps.slice(0, 15000) || '(no existing step definitions)'}
\`\`\`

${sampleScenario ? `SAMPLE SCENARIO from the same .feature file (match its style):
\`\`\`gherkin
${sampleScenario}
\`\`\`
` : ''}
POM (pages/${feature}/) — reuse existing methods where they exist:
\`\`\`typescript
${pomContent.slice(0, 12000) || '(no POM found)'}
\`\`\`

INSTRUCTIONS:
1. Produce exactly ONE Gherkin Scenario block. Start with "Scenario: ${acId}-POS-01 — <name>" (or a NEG variant).
2. Use Given/When/Then/And/But steps. Prefer existing phrases from the .steps.ts file.
3. Focus on the HAPPY PATH first (POS-01). If the AC covers rejection/validation, a NEG variant is fine.
4. Keep it 4-8 steps. Do not overreach — one scenario, one AC.
5. Do NOT include the Feature: header or Background — only the Scenario block.

OUTPUT (STRICT JSON, no markdown fences):

{
  "scenario": "Scenario: ${acId}-POS-01 — <name>\\n  Given …\\n  When …\\n  Then …\\n",
  "name": "${acId}-POS-01 — <name>",
  "newSteps": [
    { "phrase": "Given/When/Then + step text", "rationale": "no existing step covered this action" }
  ]
}

If every step you use already exists in the steps file, return "newSteps": [].`;

  const cmd = process.platform === 'win32' ? 'claude.cmd' : 'claude';
  const args = ['--print', '--dangerously-skip-permissions'];
  let proc;
  try {
    proc = spawn(cmd, args, {
      cwd: ROOT, env: process.env,
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    return res.status(500).json({ error: `claude spawn failed: ${err.message}` });
  }
  activeGenerate = { proc, startedAt: Date.now() };

  let stdout = '', stderr = '';
  proc.stdout.on('data', (d) => { stdout += d.toString(); });
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  try {
    proc.stdin.on('error', () => {});
    proc.stdin.write(prompt);
    proc.stdin.end();
  } catch (_) {}

  const TIMEOUT_MS = 90_000;
  let finished = false;
  const timer = setTimeout(() => { if (!proc.killed) killProcessTree(proc); }, TIMEOUT_MS);

  res.on('close', () => {
    if (finished) return;
    if (!proc.killed) killProcessTree(proc);
    clearTimeout(timer);
    activeGenerate = null;
  });

  proc.on('close', (code) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    activeGenerate = null;
    if (res.writableEnded || res.destroyed) return;
    // Parse first — the CLI can print a valid scenario and still exit non-zero.
    const parsed = extractJsonObject(stdout);
    if (parsed && parsed.scenario) {
      return res.json({
        scenario: String(parsed.scenario).slice(0, 5000),
        name: String(parsed.name || '').slice(0, 200),
        newSteps: Array.isArray(parsed.newSteps) ? parsed.newSteps : [],
        featureFile: existingFeatureFile ? `features/${feature}/${existingFeatureFile}` : `features/${feature}/`,
      });
    }
    const errText = stderr.trim();
    return res.status(502).json({
      error: `Draft failed — claude exited ${code}. ${errText ? errText.slice(0, 500) : 'Claude produced no usable scenario. Check that the CLI is signed in, then try again.'}`,
      stderr: stderr.slice(0, 2000),
      rawPreview: stdout.slice(0, 500),
    });
  });
  proc.on('error', (err) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    activeGenerate = null;
    if (res.writableEnded || res.destroyed) return;
    res.status(500).json({ error: `claude error: ${err.message}` });
  });
});

// ---- AI Explain Failure ------------------------------------------------
// Translate a test failure into plain English suitable for a non-technical
// stakeholder (PM, product owner, QA lead). DIFFERENT from auto-heal:
// heal *fixes* the test; explain just *narrates* what happened from the
// user's perspective. Synchronous claude --print call returning structured
// JSON the UI can render inline on the triage card.
app.post('/api/explain-failure', async (req, res) => {
  const { feature, fullTitle, file, line, errorMessage, errorStack, screenshot, category } = req.body || {};

  // Validators — feature is path-validated even though we never write to
  // it (defense in depth; the user-story / feature-file reads use it).
  if (!feature || !isSafeName(feature)) {
    return res.status(400).json({ error: `feature must match ${SAFE_NAME_RE}` });
  }
  if (!fullTitle || typeof fullTitle !== 'string') {
    return res.status(400).json({ error: 'fullTitle is required' });
  }
  if (!errorMessage || typeof errorMessage !== 'string') {
    return res.status(400).json({ error: 'errorMessage is required' });
  }
  if (String(errorMessage).length > 8000) {
    return res.status(413).json({ error: 'errorMessage too long' });
  }

  const claudeOk = await checkClaudeCli();
  if (!claudeOk) return res.status(501).json({ error: 'claude CLI not found on PATH' });
  if (activeGenerate) return res.status(409).json({ error: 'another Claude job is in progress' });

  // Gather optional context: the user-story ACs + the matching Gherkin
  // scenario. The richer the context, the more grounded the explanation —
  // claude can name the actual user goal instead of guessing.
  let acsContext = '';
  let scenarioContext = '';
  try {
    const storiesDir = CFG_PATHS.stories;
    if (fs.existsSync(storiesDir)) {
      const storyFile = fs.readdirSync(storiesDir).find(
        (f) => f.toLowerCase().endsWith(`-${feature.toLowerCase()}.md`) && !f.startsWith('_')
      );
      if (storyFile) {
        const md = fs.readFileSync(path.join(storiesDir, storyFile), 'utf8');
        const acMatch = md.match(/##\s*Acceptance Criteria([\s\S]*?)(?:\n##|$)/i);
        acsContext = acMatch ? acMatch[1].trim().slice(0, 2000) : '';
      }
    }
    const featureDir = path.join(ROOT, 'features', feature);
    if (fs.existsSync(featureDir)) {
      const featureFile = fs.readdirSync(featureDir).find((f) => f.endsWith('.feature') && !f.startsWith('_'));
      if (featureFile) {
        const txt = fs.readFileSync(path.join(featureDir, featureFile), 'utf8');
        // The fullTitle is shaped "Feature › Scenario Name" — pull the
        // scenario name and try to locate its block. Tolerant matcher so
        // minor whitespace / pluralization drift doesn't break the lookup.
        // fullTitle is "<Feature> › <Scenario>". Bail when there's no
        // separator rather than matching the whole title against scenario
        // names — otherwise an untitled background block can pull random
        // context from the file.
        const _parts = String(fullTitle).split('›');
        const scName = _parts.length > 1 ? _parts.pop().trim() : '';
        if (scName) {
          const escName = scName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const reg = new RegExp(`Scenario(?:\\s+Outline)?:\\s*${escName}[\\s\\S]*?(?=\\n\\s*Scenario|\\n\\s*Feature|$)`, 'i');
          const m = txt.match(reg);
          if (m) scenarioContext = m[0].slice(0, 1800);
        }
      }
    }
  } catch (_) { /* best-effort — fall through to a less-grounded explanation */ }

  // Strip terminal ANSI escapes from the error message — they bleed into
  // claude's prompt as noise and waste tokens.
  const cleanErr = String(errorMessage).replace(/\[[0-9;]*m/g, '');
  const cleanStack = errorStack ? String(errorStack).replace(/\[[0-9;]*m/g, '').split('\n').slice(0, 5).join('\n').slice(0, 800) : '';

  const prompt = `You are a senior QA engineer translating a failed automated test into a plain-English explanation for a non-technical product manager. The PM has NEVER seen the test code and cares only about end-user impact.

CONTEXT:
- Feature: ${feature}
- Failing scenario: ${fullTitle}
- Failure category: ${category || 'failed'}
    failed      = an expected condition didn't hold (the product behaved differently than expected)
    broken      = the test couldn't complete (page timed out, worker died)
    interrupted = the test was killed before finishing (manual abort or external signal)
- Error message (technical, do NOT quote verbatim):
${cleanErr.slice(0, 2000)}
${cleanStack ? `\n- Stack trace excerpt:\n${cleanStack}\n` : ''}
${acsContext ? `\nUSER STORY ACCEPTANCE CRITERIA — these describe what the user is trying to do:\n${acsContext}\n` : ''}
${scenarioContext ? `\nGHERKIN SCENARIO — these are the user-visible steps:\n${scenarioContext}\n` : ''}

INSTRUCTIONS:
1. Explain what went wrong from the USER's perspective, NOT the test's. Refer to UI elements by what a user would call them ("the Sign In button", "the email field", "the dashboard").
2. FORBIDDEN vocabulary (pure code/automation jargon only):
     selector, locator, getByRole, getByLabel, getByTestId, testid, page.click, page.fill, page.goto,
     aria-attribute names (aria-*), DOM, querySelector, assertion failed, hydration, race condition,
     stack trace, regex, async, await, promise, exception, fixture
   Words that ARE allowed even though they sound technical:
     timeout, "the page took too long to load", viewport, button, form, click, field, page.
3. HARD LIMIT: the explanation MUST be 1 or 2 sentences. If you write a third sentence you have failed the task — count before responding.
4. Severity rubric — answer in order, pick the FIRST that fits:
     Q1. Can the user complete the core job at all?         NO → "blocker"
     Q2. Important feature degraded but workaround exists?  YES → "major"
     Q3. Cosmetic / convenience-only / single-edge-case?    YES → "minor"
5. If the failure is clearly a TEST/AUTOMATION issue (selector drift, timing, flaky network, expired fixture) rather than a real product bug:
   - severity = "minor" UNLESS the underlying flow is critical
   - userImpact = "Test infrastructure problem — real users are unaffected."
   - suggestedNextStep should call it out plainly ("Re-run; if it fails again, fix the test for X.")
6. Suggest ONE concrete next step.

LOW-CONTEXT FALLBACK: if there are no acceptance criteria or scenario context above (i.e. only the feature name + error message), be explicit about uncertainty in your explanation ("we don't have a user story for this feature, so the impact estimate is a best guess") and lean toward severity = "major".

EXAMPLES — study the shape AND length:

GOOD example:
  explanation: "The Sign In button stayed disabled after entering valid credentials. The user is stuck on the login screen with no way to reach the dashboard."
  userImpact: "Anyone trying to log in right now would be unable to access the app."
  severity: "blocker"
  suggestedNextStep: "File a bug — this is reproducible. Check whether the login API is rejecting valid inputs."

BAD example (too many sentences, jargon, vague):
  explanation: "The locator for #submit-btn timed out. The selector didn't resolve. The page may not have hydrated."

OUTPUT — return STRICT JSON, no markdown fences, no preamble.
The severity field MUST be one of exactly these three lowercase strings: "blocker", "major", or "minor". Do NOT use "critical", "high", "low", "p1", "trivial", or any other word.

{
  "explanation": "...",
  "userImpact": "...",
  "severity": "blocker",
  "suggestedNextStep": "..."
}`;

  const cmd = process.platform === 'win32' ? 'claude.cmd' : 'claude';
  // Short, mechanical job — pin the fast model (override with AGENTIC_QA_CLAUDE_MODEL).
  const args = withFastModel(['--print', '--dangerously-skip-permissions']);
  let proc;
  try {
    proc = spawn(cmd, args, {
      cwd: ROOT, env: process.env,
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    return res.status(500).json({ error: `claude spawn failed: ${err.message}` });
  }
  activeGenerate = { proc, startedAt: Date.now() };

  let stdout = '', stderr = '';
  proc.stdout.on('data', (d) => { stdout += d.toString(); });
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  try {
    proc.stdin.on('error', () => {});
    proc.stdin.write(prompt);
    proc.stdin.end();
  } catch (_) { /* exit handler reports */ }

  const TIMEOUT_MS = 45_000;
  let finished = false;
  const timer = setTimeout(() => { if (!proc.killed) killProcessTree(proc); }, TIMEOUT_MS);

  // Clean up when the client disconnects (tab close / network drop).
  // Without this, an abandoned request keeps `activeGenerate` held for up
  // to 45s and locks every other claude-using endpoint with 409.
  res.on('close', () => {
    if (finished) return;
    if (!proc.killed) killProcessTree(proc);
    clearTimeout(timer);
    activeGenerate = null;
  });

  proc.on('close', (code) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    activeGenerate = null;
    if (res.writableEnded || res.destroyed) return;
    // Parse first — the CLI can emit valid JSON yet still exit non-zero, so the
    // exit code only matters when there's no usable output to parse.
    const parsed = extractJsonObject(stdout);
    if (!parsed) {
      const errText = stderr.trim();
      return res.status(502).json({
        error: code !== 0
          ? `Explain failed — claude exited ${code}. ${errText ? errText.slice(0, 500) : 'No output — check the CLI is signed in, then try again.'}`
          : 'claude returned non-JSON',
        stderr: stderr.slice(0, 2000),
        rawPreview: stdout.slice(0, 500),
      });
    }
    // Accept a couple of likely key drifts — claude sometimes renames keys
    // when the prompt is dense.
    const explanationRaw = parsed.explanation || parsed.explanationText || parsed.summary || '';
    if (!explanationRaw) {
      return res.status(502).json({ error: 'response missing explanation field', rawPreview: stdout.slice(0, 500) });
    }

    // Severity normalization — catches "Major", "Blocker", "critical",
    // "high" etc. instead of silently coercing them all to "major"
    // (which would hide blocker-grade bugs).
    const sevRaw = String(parsed.severity || '').trim().toLowerCase();
    const SEVERITY_MAP = {
      critical: 'blocker', high: 'blocker', blocker: 'blocker', p0: 'blocker', p1: 'blocker',
      moderate: 'major', medium: 'major', major: 'major', p2: 'major',
      low: 'minor', trivial: 'minor', cosmetic: 'minor', minor: 'minor', p3: 'minor', p4: 'minor',
    };
    const severity = SEVERITY_MAP[sevRaw] || 'major';
    if (sevRaw && !SEVERITY_MAP[sevRaw]) {
      console.warn('[explain-failure] unknown severity from claude:', JSON.stringify(parsed.severity));
    }

    // Enforce the 2-sentence cap server-side too. Claude treats sentence
    // caps as soft suggestions; this is the hard one.
    const sentences = String(explanationRaw).split(/(?<=[.!?])\s+/).filter(Boolean);
    const explanation = sentences.slice(0, 2).join(' ').slice(0, 600);

    res.json({
      explanation,
      userImpact: String(parsed.userImpact || parsed.impact || '').slice(0, 400),
      severity,
      suggestedNextStep: String(parsed.suggestedNextStep || parsed.nextStep || parsed.recommendation || '').slice(0, 400),
    });
  });
  proc.on('error', (err) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    activeGenerate = null;
    if (res.writableEnded || res.destroyed) return;
    res.status(500).json({ error: `claude error: ${err.message}` });
  });
});

// ---- Auto-implement missing step definitions --------------------------
// When a user writes a new Gherkin scenario (manually or via the recorder),
// bddgen complains about steps it doesn't yet recognise. This endpoint
// closes that loop: it runs bddgen, parses the missing-step block out of
// its output, hands the missing phrases + the matching POM + the existing
// steps file to claude, then appends the generated implementations back
// into the right .steps.ts file. NDJSON-streamed so the user sees progress.
app.post('/api/scaffold-missing-steps', async (req, res) => {
  const { feature } = req.body || {};
  if (feature && !isSafeName(feature)) {
    return res.status(400).json({ error: `feature must match ${SAFE_NAME_RE}` });
  }
  const claudeOk = await checkClaudeCli();
  if (!claudeOk) return res.status(501).json({ error: 'claude CLI not found on PATH' });
  if (activeGenerate) return res.status(409).json({ error: 'another Claude job is in progress' });

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.on('error', () => {});
  const write = makeSafeWrite(res);

  // Helper: run bddgen + capture stdout/stderr together so we can scan for
  // the "Missing step definitions: N" block.
  async function captureBddgen() {
    return new Promise((resolve) => {
      let buf = '';
      const p = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx',
        ['bddgen', '--config', 'playwright.config.js'],
        { cwd: ROOT, env: process.env, shell: process.platform === 'win32' });
      p.stdout.on('data', (d) => { buf += d.toString(); });
      p.stderr.on('data', (d) => { buf += d.toString(); });
      p.on('close', () => resolve(buf));
      p.on('error', () => resolve(buf));
    });
  }

  write({ type: 'log', stream: 'stdout', text: '[scaffold] running bddgen to detect missing steps…\n' });
  const bddOut = await captureBddgen();

  // Parse the bddgen output. Each missing step looks like:
  //   When('phrase', async ({}) => {
  //     // Step: And I do something
  //     // From: features\<feature>\<file>.feature:N:M
  //   });
  //
  // The phrase between '…' is JS-source-escaped, so apostrophes inside it
  // appear as `\'` (e.g. `vendor\'s details`). The capturing group must
  // tolerate backslash-escape sequences — the original `[^']+?` pattern
  // stopped at the first single quote and missed any phrase containing one.
  const blockRe = /(Given|When|Then)\('((?:[^'\\]|\\.)+?)',\s*async\s*\(([^)]*)\)\s*=>\s*\{[\s\S]*?\/\/\s*From:\s*([^\s\n]+)/g;
  const missingSteps = [];
  let m;
  while ((m = blockRe.exec(bddOut)) !== null) {
    const [, keyword, escapedPhrase, params, source] = m;
    // Un-escape: \' → '   \\ → \   (drop other backslash escapes back to the raw char)
    const phrase = escapedPhrase.replace(/\\(.)/g, '$1');
    const srcNorm = String(source).replace(/\\/g, '/');
    const featMatch = srcNorm.match(/features\/([^/]+)\//);
    const detectedFeature = featMatch ? featMatch[1] : null;
    if (feature && detectedFeature !== feature) continue;
    missingSteps.push({ keyword, phrase, params: params.trim(), source: srcNorm, feature: detectedFeature });
  }

  if (missingSteps.length === 0) {
    write({ type: 'log', stream: 'stdout', text: '[scaffold] no missing step definitions found — nothing to do.\n' });
    write({ type: 'done', exitCode: 0, generatedCount: 0 });
    return res.end();
  }

  write({ type: 'log', stream: 'stdout', text: `[scaffold] found ${missingSteps.length} missing step(s) across ${new Set(missingSteps.map((s) => s.feature)).size} feature(s)\n` });

  // Group by feature so we generate + write per-feature.
  const byFeature = new Map();
  for (const s of missingSteps) {
    if (!s.feature) continue;
    if (!byFeature.has(s.feature)) byFeature.set(s.feature, []);
    byFeature.get(s.feature).push(s);
  }

  let totalGenerated = 0;
  // Collected per-step code blocks across all features — surfaced in the
  // done event so the recorder review panel can display them.
  const generatedStepsByFeature = {};
  for (const [feat, steps] of byFeature) {
    write({ type: 'log', stream: 'stdout', text: `\n[scaffold] feature "${feat}" — ${steps.length} step(s) to implement\n` });

    const stepsDir = path.join(ROOT, 'features', feat);
    if (!fs.existsSync(stepsDir)) {
      write({ type: 'log', stream: 'stderr', text: `[scaffold]   feature folder not found: features/${feat}/\n` });
      continue;
    }
    const stepsFileName = fs.readdirSync(stepsDir).find((f) => f.endsWith('.steps.ts'));
    if (!stepsFileName) {
      write({ type: 'log', stream: 'stderr', text: `[scaffold]   no .steps.ts in features/${feat}/ — recorder/Save&Generate normally creates this\n` });
      continue;
    }
    const stepsPath = path.join(stepsDir, stepsFileName);
    const existingSteps = fs.readFileSync(stepsPath, 'utf8');

    // POMs give claude method context — pages/<feat>/*.ts
    const pomDir = path.join(ROOT, 'pages', feat);
    const pomFiles = fs.existsSync(pomDir)
      ? fs.readdirSync(pomDir).filter((f) => f.endsWith('.ts'))
      : [];
    let pomContent = '';
    for (const f of pomFiles) {
      const txt = fs.readFileSync(path.join(pomDir, f), 'utf8');
      pomContent += `\n// ----- pages/${feat}/${f} -----\n${txt.slice(0, 6000)}\n`;
    }

    const stepList = steps.map((s, i) => `${i + 1}. ${s.keyword}: "${s.phrase}"`).join('\n');
    const prompt = `Generate Playwright-BDD step definition implementations for these missing Gherkin steps. Return STRICT JSON, no markdown fences, no preamble.

MISSING STEPS:
${stepList}

EXISTING STEP-DEFINITIONS FILE (features/${feat}/${stepsFileName}) — match its imports, createBdd tag-scoping, and POM-wrapping style:
\`\`\`typescript
${existingSteps.slice(0, 18000)}
\`\`\`

EXISTING PAGE OBJECT FILES under pages/${feat}/ — reuse these methods where they fit:
\`\`\`typescript
${pomContent.slice(0, 14000)}
\`\`\`

INSTRUCTIONS:
1. Generate ONE complete step block per missing step. Use the SAME { Given, When, Then } binding pattern already in the steps file (e.g. tag-scoped createBdd).
2. PREFER calling existing POM methods. If a needed method doesn't exist, use inline page.click / page.fill / page.getByRole / expect(...).toBeVisible — do NOT invent POM methods that aren't already in the POM files above.
3. {string} or {int} args from the Gherkin phrase map to function parameters; type them as string / number.
4. Each step should be 3-12 lines. Add no comments except where logic is non-obvious.
5. If the same import would already be present in the existing steps file, omit it from newImports.

OUTPUT EXACTLY this JSON shape:
{
  "steps": [
    { "keyword": "When", "phrase": "I navigate to the Vendors List under Quick Inventory", "code": "When('I navigate to the Vendors List under Quick Inventory', async ({ page }) => {\\n  // ...\\n});" }
  ],
  "newImports": [],
  "summary": "Implemented 4 steps using DashboardPage + page.getByRole."
}`;

    const cmd = process.platform === 'win32' ? 'claude.cmd' : 'claude';
    const claudeArgs = ['--print', '--dangerously-skip-permissions'];
    write({ type: 'log', stream: 'stdout', text: `[scaffold]   calling claude…\n` });

    const result = await new Promise((resolve) => {
      let p;
      try {
        p = spawn(cmd, claudeArgs, { cwd: ROOT, env: process.env, shell: process.platform === 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err) {
        return resolve({ code: 1, out: '', err: err.message });
      }
      activeGenerate = { proc: p, startedAt: Date.now() };
      let out = '', err = '';
      p.stdout.on('data', (d) => { out += d.toString(); });
      p.stderr.on('data', (d) => { err += d.toString(); });
      try { p.stdin.write(prompt); p.stdin.end(); } catch (_) {}
      const timer = setTimeout(() => { if (!p.killed) killProcessTree(p); }, 120_000);
      p.on('close', (code) => { clearTimeout(timer); activeGenerate = null; resolve({ code, out, err }); });
      p.on('error', (e) => { clearTimeout(timer); activeGenerate = null; resolve({ code: 1, out: '', err: e.message }); });
    });

    if (result.code !== 0) {
      write({ type: 'log', stream: 'stderr', text: `[scaffold]   claude exited ${result.code}: ${result.err.slice(0, 400)}\n` });
      continue;
    }
    const parsed = extractJsonObject(result.out);
    if (!parsed || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      write({ type: 'log', stream: 'stderr', text: `[scaffold]   could not parse claude response\n` });
      continue;
    }

    // Update the .steps.ts file: add new imports + append step blocks under
    // a clearly-marked banner so the user can find/audit what was generated.
    let updated = existingSteps;
    const newImports = Array.isArray(parsed.newImports) ? parsed.newImports : [];
    for (const imp of newImports) {
      const trimmed = String(imp).trim();
      if (!trimmed || updated.includes(trimmed)) continue;
      const lastImportMatch = updated.match(/^[ \t]*import\s+[^\n]+;[ \t]*$/gm);
      if (lastImportMatch) {
        const lastImport = lastImportMatch[lastImportMatch.length - 1];
        const idx = updated.lastIndexOf(lastImport);
        updated = updated.slice(0, idx + lastImport.length) + '\n' + trimmed + updated.slice(idx + lastImport.length);
      } else {
        updated = trimmed + '\n' + updated;
      }
    }
    const banner = `\n\n// ---- auto-generated step definitions (scaffold-missing-steps) ----\n`;
    const stepBlocks = parsed.steps.map((s) => String(s.code || '').trim()).filter(Boolean).join('\n\n');
    updated = updated.trimEnd() + banner + stepBlocks + '\n';
    fs.writeFileSync(stepsPath, updated, 'utf8');

    totalGenerated += parsed.steps.length;
    // Stash the generated steps so the done event can carry them back to
    // the UI (for the recorder review panel etc).
    generatedStepsByFeature[feat] = parsed.steps.map((s) => ({
      keyword: s.keyword || '',
      phrase: s.phrase || '',
      code: String(s.code || '').trim(),
    }));
    write({ type: 'log', stream: 'stdout', text: `[scaffold]   wrote ${parsed.steps.length} step(s) → features/${feat}/${stepsFileName}\n` });
    if (parsed.summary) write({ type: 'log', stream: 'stdout', text: `[scaffold]   ${parsed.summary}\n` });
  }

  // Re-run bddgen to confirm what's left.
  write({ type: 'log', stream: 'stdout', text: '\n[scaffold] re-running bddgen to verify…\n' });
  const verifyOut = await captureBddgen();
  const stillMissing = parseInt((verifyOut.match(/Missing step definitions:\s*(\d+)/) || [, '0'])[1], 10);
  write({ type: 'log', stream: 'stdout', text: `[scaffold] done. Generated ${totalGenerated} step(s). ${stillMissing} step(s) still missing.\n` });
  write({
    type: 'done',
    exitCode: 0,
    generatedCount: totalGenerated,
    stillMissingCount: stillMissing,
    generatedSteps: generatedStepsByFeature,
  });
  res.end();
});

// ---- Test Recorder Integration ----------------------------------------
// Wraps `playwright codegen` so the user can drive the app manually,
// capture the generated Playwright code, and translate it into a Gherkin
// scenario via the local `claude` CLI. Completely separate from the
// Save & Generate flow — codegen is driven by clicks (not by a prompt),
// and the conversion step is a small synchronous claude call (not a
// streaming generation).
let activeRecorder = null;

// Locate where `playwright codegen` should write its output. Codegen DOES
// stream code to stdout in real-time as the user interacts (we capture
// that incrementally), AND on graceful exit (user closes the Inspector)
// it writes the final code to --output if specified. Belt-and-suspenders.
function recorderOutputFile() {
  return path.join(CFG_PATHS.testResults, '.recorder-output.js');
}

app.post('/api/recorder/start', (req, res) => {
  const { url, browser } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url is required' });
  }
  // Basic URL sanity — codegen accepts file:// too, but we only want HTTP(S)
  // here since this is a web QA tool.
  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'url must start with http:// or https://' });
  }
  if (url.length > 2048) {
    return res.status(400).json({ error: 'url too long' });
  }
  const safeBrowsers = new Set(['chromium', 'firefox', 'webkit']);
  const useBrowser = safeBrowsers.has(browser) ? browser : 'chromium';

  if (activeRecorder) {
    return res.status(409).json({ error: 'a recording is already in progress; stop it first' });
  }

  // Make sure the output dir exists + the previous output is wiped so the
  // capture for THIS recording is clean.
  try {
    fs.mkdirSync(CFG_PATHS.testResults, { recursive: true });
    if (fs.existsSync(recorderOutputFile())) fs.unlinkSync(recorderOutputFile());
  } catch (_) { /* best-effort */ }

  const args = [
    'playwright', 'codegen',
    '--target=javascript',
    `--browser=${useBrowser}`,
    `--output=${recorderOutputFile()}`,
    url,
  ];
  let proc;
  try {
    proc = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, {
      cwd: ROOT,
      env: process.env,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return res.status(500).json({ error: `failed to spawn codegen: ${err.message}` });
  }

  // Accumulate stdout — codegen streams the regenerated code as the user
  // interacts, so the latest snapshot reflects the current recording state.
  let captured = '';
  let stderr = '';
  proc.stdout.on('data', (d) => { captured += d.toString(); });
  proc.stderr.on('data', (d) => { stderr += d.toString(); });

  const startedAt = Date.now();
  activeRecorder = {
    proc,
    startedAt,
    url,
    browser: useBrowser,
    getCaptured: () => captured,
    getStderr: () => stderr,
  };

  // When codegen exits gracefully (user closes the Inspector window), the
  // final code lands in the --output file. We don't auto-respond here —
  // the client polls /api/recorder/status or calls /stop.
  proc.on('close', (code) => {
    if (activeRecorder && activeRecorder.proc === proc) {
      activeRecorder.exitCode = code;
      activeRecorder.endedAt = Date.now();
    }
  });
  proc.on('error', (err) => {
    if (activeRecorder && activeRecorder.proc === proc) {
      activeRecorder.error = String(err && err.message);
      activeRecorder.endedAt = Date.now();
    }
  });

  res.json({ ok: true, recordingId: String(startedAt), url, browser: useBrowser });
});

app.get('/api/recorder/status', (_req, res) => {
  if (!activeRecorder) {
    return res.json({ active: false });
  }
  const exited = activeRecorder.proc.killed || activeRecorder.exitCode != null;
  res.json({
    active: !exited,
    recordingId: String(activeRecorder.startedAt),
    url: activeRecorder.url,
    browser: activeRecorder.browser,
    capturedChars: activeRecorder.getCaptured().length,
    exitCode: activeRecorder.exitCode ?? null,
    error: activeRecorder.error || null,
  });
});

app.post('/api/recorder/stop', (_req, res) => {
  if (!activeRecorder) {
    return res.status(404).json({ error: 'no active recording' });
  }
  const rec = activeRecorder;
  // SIGTERM first so codegen has a chance to flush --output; if it lingers
  // past 800ms we send a hard kill so the user isn't stuck.
  try { if (!rec.proc.killed) rec.proc.kill('SIGTERM'); } catch (_) { /* already dead */ }
  setTimeout(() => {
    if (rec.proc && !rec.proc.killed) killProcessTree(rec.proc);
  }, 800);

  // Give the process a moment to flush the --output file, then read it.
  // Stream stdout is the fallback if the file is empty or missing.
  setTimeout(() => {
    let code = '';
    try {
      if (fs.existsSync(recorderOutputFile())) {
        code = fs.readFileSync(recorderOutputFile(), 'utf8');
      }
    } catch (_) { /* fall through to stdout */ }
    if (!code || code.trim().length < 10) code = rec.getCaptured();
    activeRecorder = null;
    res.json({
      ok: true,
      code: code || '',
      stderr: rec.getStderr().slice(0, 1000),
      durationMs: Date.now() - rec.startedAt,
    });
  }, 900);
});

// Convert the captured Playwright code into a Gherkin scenario. The prompt
// gives claude the existing step-definition file so the generated scenario
// REUSES existing step phrases where possible instead of inventing new ones.
// Synchronous like /api/critique-spec — small response, UI shows a spinner.
app.post('/api/recorder/convert', async (req, res) => {
  const { code, feature } = req.body || {};
  if (!code || typeof code !== 'string' || code.trim().length < 20) {
    return res.status(400).json({ error: 'code (the captured Playwright script) is required' });
  }
  if (feature && !isSafeName(feature)) {
    return res.status(400).json({ error: `feature must match ${SAFE_NAME_RE}` });
  }
  const claudeOk = await checkClaudeCli();
  if (!claudeOk) return res.status(501).json({ error: 'claude CLI not found on PATH' });
  if (activeGenerate) return res.status(409).json({ error: 'another Claude job is in progress' });

  // What steps already exist, so claude reuses a phrase instead of inventing one.
  //
  // Two parts, on purpose:
  //  - the compact phrase index (authoritative, complete, tag-scoped) — ~0.7-1.7KB
  //    where dumping the raw .steps.ts was 8-10KB, and the raw dump was also
  //    truncated at 30KB so on a big feature it silently hid definitions;
  //  - a trimmed slice of the real file, purely so new steps match the house style.
  let stepPhraseIndex = '';
  let recorderIndex = null;
  try {
    recorderIndex = stepIndex.readStepIndex({ root: ROOT });
    const tags = featureTagsFor(feature);
    stepPhraseIndex = stepIndex.renderForPrompt(recorderIndex, tags);
  } catch (_) { /* fall back to the raw sample below */ }

  let existingSteps = '';
  if (feature) {
    const stepsDir = path.join(ROOT, 'features', feature);
    if (fs.existsSync(stepsDir)) {
      const stepsFile = fs.readdirSync(stepsDir).find((f) => f.endsWith('.steps.ts'));
      if (stepsFile) {
        try { existingSteps = fs.readFileSync(path.join(stepsDir, stepsFile), 'utf8').slice(0, 6_000); }
        catch (_) { /* missing/unreadable — claude will invent new steps */ }
      }
    }
  }

  const prompt = `Convert this captured Playwright codegen output into ONE Gherkin Scenario block.

CAPTURED PLAYWRIGHT CODE (from \`playwright codegen\`):
\`\`\`javascript
${code.slice(0, 8000)}
\`\`\`

${stepPhraseIndex ? `STEP PHRASES ALREADY AVAILABLE to feature "${feature}" (complete and authoritative — every one of these is implemented and in scope). REUSE these verbatim whenever the captured action maps to one. Do NOT invent a new step when one of these fits, and do NOT list any of these under newSteps.

${stepPhraseIndex}
` : ''}
${existingSteps ? `STYLE SAMPLE — how step definitions are written in this feature (for matching house style only; the authoritative phrase list is above):

\`\`\`typescript
${existingSteps}
\`\`\`
` : ''}
INSTRUCTIONS:
1. Output ONE Scenario block in Gherkin. Start with a one-line "Scenario:" name that describes what the user just did, then Given/When/Then steps.
2. Prefer existing step phrasings from the list above when they match.
3. Skip browser navigation that just goes back to the start URL (treat that as the Background — don't add a Given for it unless the existing steps already have one).
4. Group multiple consecutive clicks/fills on the same form into a higher-level When step where it makes sense ("When I fill the sign-in form and submit" instead of 5 separate fill/click whens) — but only IF that matches the existing-step style.
5. Output STRICT JSON with this exact shape, nothing else:

{
  "scenario": "Scenario: <name>\\n  Given …\\n  When …\\n  Then …\\n",
  "name": "<one-line scenario name>",
  "newSteps": [
    { "phrase": "When I do something new", "rationale": "no existing step covered this action" }
  ]
}

If every step you used already exists in the steps file, return newSteps: [].`;

  // Run claude --print synchronously and parse JSON out of its response.
  const cmd = process.platform === 'win32' ? 'claude.cmd' : 'claude';
  // Short, mechanical job — pin the fast model (override with AGENTIC_QA_CLAUDE_MODEL).
  const args = withFastModel(['--print', '--dangerously-skip-permissions']);
  let proc;
  try {
    proc = spawn(cmd, args, {
      cwd: ROOT,
      env: process.env,
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    return res.status(500).json({ error: `claude spawn failed: ${err.message}` });
  }
  activeGenerate = { proc, startedAt: Date.now() };
  let stdout = '', stderr = '';
  proc.stdout.on('data', (d) => { stdout += d.toString(); });
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  try {
    proc.stdin.on('error', () => {});
    proc.stdin.write(prompt);
    proc.stdin.end();
  } catch (_) { /* handled below */ }

  const TIMEOUT_MS = 90_000;
  const timer = setTimeout(() => { if (!proc.killed) killProcessTree(proc); }, TIMEOUT_MS);

  proc.on('close', (exitCode) => {
    clearTimeout(timer);
    activeGenerate = null;
    // Parse the model output FIRST, regardless of exit code. The Claude CLI
    // frequently prints a valid answer to stdout and STILL exits non-zero
    // (a post-run telemetry/update warning, a broken stdout pipe on Windows,
    // etc.). Bailing on exitCode before parsing threw away good scenarios and
    // surfaced a bare "claude exited 1" — that was the recorder→Gherkin bug.
    const parsed = extractJsonObject(stdout);
    if (parsed && parsed.scenario) {
      if (exitCode !== 0 && stderr.trim()) {
        console.warn(`[recorder/convert] claude exited ${exitCode} but produced a usable scenario; stderr: ${stderr.trim().slice(0, 300)}`);
      }
      // Verify the model's "this step is new" claim against the index rather
      // than trusting it. A false positive here is expensive: it scaffolds a
      // duplicate definition of a step that already works, and duplicates are
      // exactly what the tag-scoped step library already suffers from.
      let claimedNew = Array.isArray(parsed.newSteps) ? parsed.newSteps : [];
      let correctedNew = claimedNew;
      const alreadyExisted = [];
      if (recorderIndex && claimedNew.length) {
        const tags = featureTagsFor(feature);
        correctedNew = claimedNew.filter((s) => {
          const phrase = typeof s === 'string' ? s : (s && s.phrase) || '';
          if (!phrase) return true;
          const verdict = stepIndex.matchStep(phrase, recorderIndex, { tags });
          if (verdict.status === 'none') return true;
          alreadyExisted.push(phrase);
          return false;
        });
        if (alreadyExisted.length) {
          console.log(`[recorder/convert] dropped ${alreadyExisted.length} "new" step(s) that already exist: ${alreadyExisted.join(' | ')}`);
        }
      }
      return res.json({
        scenario: parsed.scenario,
        name: parsed.name || '',
        newSteps: correctedNew,
        // Surfaced so the review panel can say why the list shrank.
        alreadyImplemented: alreadyExisted,
      });
    }
    // No usable output — surface the actual reason instead of a bare exit code.
    const errText = stderr.trim();
    if (errText) console.error('[recorder/convert] claude stderr:', errText);
    // Exit 1 with no stderr and no stdout is almost always an un-authenticated
    // CLI or an exhausted usage limit — give the user an actionable hint.
    const hint = errText
      ? errText.slice(0, 600)
      : (stdout.trim()
        ? 'Claude replied but not in the expected JSON format — try Convert again.'
        : 'Claude produced no output. The CLI is likely not signed in (open a terminal, run `claude`, and log in) or a usage limit was hit.');
    return res.status(502).json({
      error: `Convert failed — claude exited ${exitCode}. ${hint}`,
      stderr: stderr.slice(0, 2000),
      rawPreview: stdout.slice(0, 500),
    });
  });
  proc.on('error', (err) => {
    clearTimeout(timer);
    activeGenerate = null;
    res.status(500).json({ error: `claude error: ${err.message}` });
  });
});

// Append a Gherkin scenario to the target feature's .feature file. The file
// must already exist — recorder is for ADDING scenarios to an existing
// feature, not for scaffolding new ones (that's what Save & Generate is for).
app.post('/api/recorder/append', (req, res) => {
  const { feature, scenario } = req.body || {};
  if (!feature || !isSafeName(feature)) {
    return res.status(400).json({ error: `feature must match ${SAFE_NAME_RE}` });
  }
  if (!scenario || typeof scenario !== 'string' || scenario.trim().length < 10) {
    return res.status(400).json({ error: 'scenario text is required' });
  }
  if (scenario.length > 10_000) {
    return res.status(413).json({ error: 'scenario too long' });
  }
  const featureDir = path.join(ROOT, 'features', feature);
  if (!fs.existsSync(featureDir)) {
    return res.status(404).json({ error: `feature folder not found: features/${feature}/` });
  }
  const featureFile = fs.readdirSync(featureDir).find((f) => f.endsWith('.feature') && !f.startsWith('_'));
  if (!featureFile) {
    return res.status(404).json({ error: `no .feature file in features/${feature}/` });
  }
  const filePath = path.join(featureDir, featureFile);
  try {
    const existing = fs.readFileSync(filePath, 'utf8');
    // Ensure exactly one blank line between the previous content and the new scenario.
    const trimmed = existing.replace(/\s+$/, '');
    const appended = `${trimmed}\n\n${scenario.replace(/^\s+/, '').trimEnd()}\n`;
    fs.writeFileSync(filePath, appended, 'utf8');
    res.json({ ok: true, file: `features/${feature}/${featureFile}`, scenarioBytes: scenario.length });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message) });
  }
});

// PR Impact Radar: uses `git diff` + `git status` to identify which files have
// changed vs the base branch, then maps those files to features whose scenarios
// are likely affected. Heuristic mapping — designed to catch obvious cases.
app.get('/api/pr-impact', (req, res) => {
  const base = String(req.query.base || 'main').replace(/[^a-zA-Z0-9._/-]/g, '');
  const includeUncommitted = req.query.uncommitted !== '0';
  try { execSync('git rev-parse --git-dir', { cwd: ROOT, stdio: 'pipe' }); }
  catch { return res.json({ isGitRepo: false, impactedFeatures: [], changedFiles: [] }); }

  let committed = [], uncommitted = [];
  try {
    committed = execSync(`git diff --name-only ${base}...HEAD`, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter(Boolean);
  } catch {
    try {
      committed = execSync(`git diff --name-only HEAD~5..HEAD`, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split('\n').filter(Boolean);
    } catch { committed = []; }
  }
  if (includeUncommitted) {
    try {
      uncommitted = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' })
        .split('\n').filter(Boolean)
        .map((l) => l.slice(3).replace(/^"|"$/g, '').replace(/\\/g, '/').split(' -> ').pop().trim());
    } catch { uncommitted = []; }
  }
  const allChanged = [...new Set([...committed, ...uncommitted])].filter(Boolean);

  const featuresRoot = path.join(ROOT, 'features');
  let features = [];
  try {
    features = fs.readdirSync(featuresRoot)
      .filter((n) => !n.startsWith('_') && !n.startsWith('.') && fs.statSync(path.join(featuresRoot, n)).isDirectory());
  } catch { features = []; }

  const featureScenarios = new Map();
  const featureSteps = new Map();
  for (const f of features) {
    const dir = path.join(featuresRoot, f);
    try {
      const files = fs.readdirSync(dir);
      const featureFile = files.find((x) => x.endsWith('.feature') && !x.startsWith('_'));
      if (featureFile) {
        const content = fs.readFileSync(path.join(dir, featureFile), 'utf8');
        featureScenarios.set(f, (content.match(/^\s*Scenario:/gm) || []).length);
      }
      const stepsFile = files.find((x) => x.endsWith('.steps.ts'));
      if (stepsFile) featureSteps.set(f, fs.readFileSync(path.join(dir, stepsFile), 'utf8'));
    } catch { /* skip */ }
  }

  const impact = new Map(); // feature -> Set of reasons
  const addImpact = (feature, reason) => {
    if (!impact.has(feature)) impact.set(feature, new Set());
    impact.get(feature).add(reason);
  };

  // A package.json change only counts as cross-cutting (i.e. flags EVERY
  // feature) when it actually changes dependencies. Version bumps, script
  // edits, and npm metadata shouldn't blanket-flag the whole suite — otherwise
  // "impacted" degrades to "all features" on any branch that touched
  // package.json, and "Run impacted" runs everything. Compared by parsing the
  // dependency maps at `base` vs. now; memoized so we do it at most once.
  let _pkgDepsCache = null;
  function pkgDepsChanged() {
    if (_pkgDepsCache !== null) return _pkgDepsCache;
    try {
      const cur = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
      let baseJson;
      try {
        baseJson = JSON.parse(execSync(`git show ${base}:package.json`, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
      } catch {
        _pkgDepsCache = true; return true; // can't read base copy → assume it matters
      }
      const deps = (p) => JSON.stringify({
        d: p.dependencies || {}, dd: p.devDependencies || {},
        pd: p.peerDependencies || {}, od: p.optionalDependencies || {},
      });
      _pkgDepsCache = deps(cur) !== deps(baseJson);
    } catch {
      _pkgDepsCache = true; // on any error, be conservative
    }
    return _pkgDepsCache;
  }

  for (const file of allChanged) {
    const norm = file.replace(/\\/g, '/');
    const fMatch = norm.match(/^features\/([^/]+)\//);
    if (fMatch && features.includes(fMatch[1])) {
      const kind = norm.endsWith('.feature') ? 'scenario file' :
        norm.endsWith('.steps.ts') ? 'step defs' : 'file';
      addImpact(fMatch[1], `Direct: ${kind} changed`);
      continue;
    }
    const pMatch = norm.match(/^pages\/([^/]+)\//);
    if (pMatch) {
      const pageDir = pMatch[1];
      const fileName = path.basename(norm, path.extname(norm));
      for (const [feat, stepsCode] of featureSteps.entries()) {
        const importRe = new RegExp(`from\\s+['\"][^'\"]*pages/${pageDir}(?:/[^'\"]*)?['\"]`, 'g');
        const classRe = new RegExp(`\\b${fileName}\\b`, 'g');
        if (importRe.test(stepsCode) || classRe.test(stepsCode)) {
          addImpact(feat, `POM: pages/${pageDir}/ referenced`);
        }
      }
      continue;
    }
    const sMatch = norm.match(/^user-stories\/(.+)\.md$/i);
    if (sMatch) {
      const storyName = sMatch[1].toLowerCase();
      for (const f of features) {
        const slug = f.toLowerCase().replace(/-/g, '');
        if (storyName.replace(/-/g, '').includes(slug) || slug.includes(storyName.replace(/-/g, ''))) {
          addImpact(f, `Story changed: ${path.basename(sMatch[1])}`);
        }
      }
      continue;
    }
    const cfgMatch = norm.match(/^(playwright\.config\.js|package\.json|features\/_shared\/|utils\/)/);
    if (cfgMatch) {
      // Skip a package.json change that didn't touch dependencies — it isn't
      // genuinely cross-cutting, so it shouldn't mark every feature impacted.
      if (cfgMatch[1] === 'package.json' && !pkgDepsChanged()) continue;
      for (const f of features) addImpact(f, `Global: ${cfgMatch[1]} changed`);
    }
  }

  const impactedFeatures = [...impact.entries()]
    .map(([name, reasons]) => ({
      name,
      reasons: [...reasons],
      scenarioCount: featureScenarios.get(name) || 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  res.json({
    isGitRepo: true,
    base,
    changedFiles: allChanged,
    committedCount: committed.length,
    uncommittedCount: uncommitted.length,
    impactedFeatures,
  });
});

// ------------------- Test Tags Manager --------------------------------------
// Gherkin tags live on the line(s) directly above a Scenario keyword. Format:
//   @smoke @critical
//   Scenario: AC1-POS-01 — happy path
// We parse these into a per-scenario tag list and support rewriting them.

function parseFeatureFileTags(content) {
  // Returns [{ name, tags: [], lineIndex, tagLineIndex|null }]
  const lines = content.split(/\r?\n/);
  const scenarios = [];
  let pendingTags = null;
  let pendingTagLineIdx = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    // Blank line resets pending tags (Gherkin tag block must be contiguous with the scenario).
    if (trimmed === '') { continue; }
    // A tag line is one that consists entirely of @-prefixed tokens.
    if (/^(\s*@[A-Za-z0-9_.-]+\s*)+$/.test(line) && trimmed.startsWith('@')) {
      pendingTags = trimmed.split(/\s+/).filter((t) => t.startsWith('@'));
      pendingTagLineIdx = i;
      continue;
    }
    const scMatch = trimmed.match(/^Scenario(?:\s+Outline)?:\s*(.+)$/);
    if (scMatch) {
      scenarios.push({
        name: scMatch[1].trim(),
        tags: pendingTags || [],
        lineIndex: i,
        tagLineIndex: pendingTags ? pendingTagLineIdx : null,
      });
      pendingTags = null;
      pendingTagLineIdx = null;
    } else if (/^(Feature|Background|Rule|Given|When|Then|And|But|Examples|\|)/.test(trimmed)) {
      // Any other Gherkin keyword resets pending tags (tag block must be adjacent).
      pendingTags = null;
      pendingTagLineIdx = null;
    }
  }
  return scenarios;
}

// GET /api/tags?feature=X — list all scenarios + their current tags
app.get('/api/tags', (req, res) => {
  const feature = String(req.query.feature || '').trim();
  if (!feature || !isSafeName(feature)) {
    return res.status(400).json({ error: `feature must match ${SAFE_NAME_RE}` });
  }
  const featureDir = path.join(ROOT, 'features', feature);
  if (!fs.existsSync(featureDir)) {
    return res.status(404).json({ error: `features/${feature}/ does not exist` });
  }
  const featureFile = fs.readdirSync(featureDir).find((f) => f.endsWith('.feature') && !f.startsWith('_'));
  if (!featureFile) return res.json({ feature, scenarios: [] });
  let content;
  try { content = fs.readFileSync(path.join(featureDir, featureFile), 'utf8'); }
  catch (err) { return res.status(500).json({ error: String(err.message) }); }
  const scenarios = parseFeatureFileTags(content).map((s) => ({ name: s.name, tags: s.tags }));
  // Collate the union of tags across the file so the UI can offer them as
  // quick-pick suggestions (common existing tags).
  const knownTags = [...new Set(scenarios.flatMap((s) => s.tags))].sort();
  res.json({ feature, featureFile: `features/${feature}/${featureFile}`, scenarios, knownTags });
});

// POST /api/tags — replace the tag line above a scenario. Body:
//   { feature, scenarioName, tags: ["@smoke", ...] }
// Passing an empty tags array removes the tag line.
app.post('/api/tags', (req, res) => {
  const { feature, scenarioName, tags } = req.body || {};
  if (!feature || !isSafeName(feature)) {
    return res.status(400).json({ error: `feature must match ${SAFE_NAME_RE}` });
  }
  if (!scenarioName || typeof scenarioName !== 'string') {
    return res.status(400).json({ error: 'scenarioName is required' });
  }
  if (!Array.isArray(tags)) {
    return res.status(400).json({ error: 'tags must be an array of strings' });
  }
  const cleanTags = tags.map((t) => String(t).trim())
    .filter((t) => /^@[A-Za-z0-9_.-]+$/.test(t));
  if (cleanTags.length !== tags.length) {
    return res.status(400).json({ error: 'each tag must match ^@[A-Za-z0-9_.-]+$' });
  }
  if (cleanTags.length > 15) {
    return res.status(400).json({ error: 'max 15 tags per scenario' });
  }
  const featureDir = path.join(ROOT, 'features', feature);
  if (!fs.existsSync(featureDir)) {
    return res.status(404).json({ error: `features/${feature}/ does not exist` });
  }
  const featureFile = fs.readdirSync(featureDir).find((f) => f.endsWith('.feature') && !f.startsWith('_'));
  if (!featureFile) return res.status(404).json({ error: 'no .feature file found' });
  const filePath = path.join(featureDir, featureFile);
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); }
  catch (err) { return res.status(500).json({ error: String(err.message) }); }
  const scenarios = parseFeatureFileTags(content);
  const target = scenarios.find((s) => s.name === scenarioName);
  if (!target) return res.status(404).json({ error: `scenario "${scenarioName}" not found` });
  const lines = content.split(/\r?\n/);
  // Figure out the indent used on the scenario line so the tag line matches.
  const indent = (lines[target.lineIndex].match(/^(\s*)/) || ['', ''])[1];
  const newTagLine = cleanTags.length ? `${indent}${cleanTags.join(' ')}` : null;
  if (target.tagLineIndex !== null) {
    // There's an existing tag line — replace or remove it.
    if (newTagLine === null) {
      lines.splice(target.tagLineIndex, 1);
    } else {
      lines[target.tagLineIndex] = newTagLine;
    }
  } else if (newTagLine !== null) {
    // No existing tag line — insert directly above the scenario keyword.
    lines.splice(target.lineIndex, 0, newTagLine);
  }
  const out = lines.join(content.includes('\r\n') ? '\r\n' : '\n');
  try { fs.writeFileSync(filePath, out, 'utf8'); }
  catch (err) { return res.status(500).json({ error: String(err.message) }); }
  res.json({ ok: true, feature, scenarioName, tags: cleanTags, file: `features/${feature}/${featureFile}` });
});

// ------------------- Scheduled Runs -----------------------------------------
// Lightweight cron replacement — supports interval / daily / weekly modes.
// State persists to .claude/schedules.json. A single scheduler tick runs every
// SCHEDULE_TICK_MS to check for due schedules. When a schedule fires, we spawn
// the same `npx playwright test` process that /api/run uses, but write its
// output to reports/scheduled-runs/<id>.log instead of a streaming client.

const SCHEDULES_DIR = path.join(ROOT, '.claude');
const SCHEDULES_FILE = path.join(SCHEDULES_DIR, 'schedules.json');
const SCHEDULE_LOGS_DIR = path.join(ROOT, 'reports', 'scheduled-runs');
const SCHEDULE_OUTPUT_DIR = path.join(ROOT, 'test-results-scheduled');
// How often the scheduler checks for due schedules. This is also the worst-case
// lateness for a "daily at 09:00" — computeNextRun works out the exact instant,
// but nothing fires until the next tick observes it. 5s keeps a timed run
// visibly punctual; the check itself is one small JSON read.
const SCHEDULE_TICK_MS = 5_000;
const SCHEDULE_ID_RE = /^sch_[a-z0-9_]+$/;
// Retention caps. Scheduled runs are fire-and-forget and nothing used to prune
// their output, so an every-N-minute schedule grew both dirs without bound (a
// 1-minute schedule left behind 161 logs + 151 artifact dirs / ~74 MB). Keep a
// useful window of recent history and drop the rest after each run.
const SCHEDULE_LOG_RETENTION = 20;       // logs kept per schedule
const SCHEDULE_ARTIFACT_RETENTION = 40;  // test-results-scheduled/ dirs kept in total
const SCHEDULE_LOG_MAX_BYTES = 256 * 1024; // largest log body served to the UI
// Hard ceiling on a single scheduled run. This is a safety net, not a policy
// timer: a scheduled run holds the run lock, so one that wedges (a hung page
// against a slow live app, a browser that never exits) would otherwise block
// every later scheduled AND interactive run for the life of the process.
// A full headed matrix legitimately takes tens of minutes, hence 30.
// Overridable via env so the kill path can be exercised without a 30 min wait.
const SCHEDULE_RUN_MAX_MS = Number(process.env.AGENTIC_QA_SCHEDULE_MAX_MS) || 30 * 60_000;

// Last list this process parsed successfully. Used as the fallback for a failed
// read so a corrupt file can never present as "the user has no schedules".
let lastGoodSchedules = null;

function loadSchedules() {
  try {
    if (!fs.existsSync(SCHEDULES_FILE)) { lastGoodSchedules = []; return []; }
    const parsed = JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('schedules.json is not an array');
    lastGoodSchedules = parsed;
    return parsed;
  } catch (err) {
    // A half-written or corrupt file must NOT read back as an empty list: a
    // caller that then saves turns a transient read failure into permanent
    // deletion of every schedule. Fall back to the last good copy instead.
    console.error('loadSchedules failed (keeping last known good):', err.message);
    return lastGoodSchedules ? JSON.parse(JSON.stringify(lastGoodSchedules)) : [];
  }
}
function saveSchedules(list) {
  if (!Array.isArray(list)) return;
  try {
    if (!fs.existsSync(SCHEDULES_DIR)) fs.mkdirSync(SCHEDULES_DIR, { recursive: true });
    // Write-then-rename. A truncating in-place write can be interrupted (crash,
    // kill, or a second UI instance started on another port sharing this file)
    // and leave an empty or half-written schedules.json behind.
    const tmp = `${SCHEDULES_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
    fs.renameSync(tmp, SCHEDULES_FILE);
    lastGoodSchedules = list;
  } catch (err) { console.error('saveSchedules failed:', err.message); }
}
function computeNextRun(schedule, fromTs) {
  const from = fromTs || Date.now();
  if (schedule.mode === 'interval') {
    const mins = Math.max(1, Number(schedule.intervalMinutes) || 60);
    return from + mins * 60_000;
  }
  const d = new Date(from);
  const h = Math.max(0, Math.min(23, Number(schedule.hour) || 0));
  const m = Math.max(0, Math.min(59, Number(schedule.minute) || 0));
  if (schedule.mode === 'daily') {
    const next = new Date(d);
    next.setHours(h, m, 0, 0);
    if (next.getTime() <= from) next.setDate(next.getDate() + 1);
    return next.getTime();
  }
  if (schedule.mode === 'weekly') {
    const dow = Math.max(0, Math.min(6, Number(schedule.dayOfWeek) || 0));
    const next = new Date(d);
    next.setHours(h, m, 0, 0);
    let diff = (dow - next.getDay() + 7) % 7;
    if (diff === 0 && next.getTime() <= from) diff = 7;
    next.setDate(next.getDate() + diff);
    return next.getTime();
  }
  return from + 3600_000;
}
function humanFrequency(s) {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  if (s.mode === 'interval') return `Every ${s.intervalMinutes} min`;
  const hh = String(s.hour).padStart(2, '0'), mm = String(s.minute).padStart(2, '0');
  if (s.mode === 'daily') return `Daily at ${hh}:${mm}`;
  if (s.mode === 'weekly') return `Every ${DAYS[s.dayOfWeek]} at ${hh}:${mm}`;
  return 'Unknown';
}

// The `line` reporter renders progress by overwriting a single terminal line
// with cursor-up + erase-line escapes. Written to a file those escapes make the
// log unreadable, but the *lines* themselves are more useful than the one final
// line a terminal would leave visible — so drop the control sequences and keep
// every line.
function stripTerminalControl(s) {
  // Match the ESC byte explicitly (\x1b). A bare /\[[0-9;]*[A-Za-z]/ would also
  // eat the "[f" out of test lines like "[firefox] > ...".
  return String(s).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

// Pull the pass/fail tallies out of a `line` reporter run so a schedule card can
// show "33 passed" instead of a bare ✓. Returns null when no summary is present
// (run still in flight, crashed before reporting, or bddgen failed).
function parseRunSummary(text) {
  const tail = stripTerminalControl(text).slice(-4000);
  const count = (re) => { const m = tail.match(re); return m ? Number(m[1]) : 0; };
  const passed = count(/(\d+)\s+passed/);
  const failed = count(/(\d+)\s+failed/);
  const flaky = count(/(\d+)\s+flaky/);
  const skipped = count(/(\d+)\s+skipped/);
  const total = passed + failed + flaky + skipped;
  if (!total) return null;
  // Duration is printed alongside the final tally, so take the last match.
  const durations = tail.match(/\((\d+(?:\.\d+)?(?:ms|s|m))\)/g) || [];
  const duration = durations.length
    ? durations[durations.length - 1].slice(1, -1)
    : '';
  return { passed, failed, flaky, skipped, total, duration };
}

// Keep only the newest SCHEDULE_LOG_RETENTION logs for one schedule.
function pruneScheduleLogs(scheduleId) {
  try {
    if (!fs.existsSync(SCHEDULE_LOGS_DIR)) return;
    const prefix = `${scheduleId}-`;
    const logs = fs.readdirSync(SCHEDULE_LOGS_DIR)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.log'))
      .map((f) => ({ f, ts: Number(f.slice(prefix.length, -4)) || 0 }))
      .sort((a, b) => b.ts - a.ts);
    for (const { f } of logs.slice(SCHEDULE_LOG_RETENTION)) {
      fs.rmSync(path.join(SCHEDULE_LOGS_DIR, f), { force: true });
    }
  } catch (err) { console.error('pruneScheduleLogs:', err.message); }
}

// Cap test-results-scheduled/ by total dir count. Artifacts land here from every
// schedule with no per-schedule namespacing, and nothing in the UI ever reads
// them back — they exist only for a manual `playwright show-trace`.
function pruneScheduleArtifacts() {
  try {
    if (!fs.existsSync(SCHEDULE_OUTPUT_DIR)) return;
    const dirs = fs.readdirSync(SCHEDULE_OUTPUT_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const full = path.join(SCHEDULE_OUTPUT_DIR, e.name);
        const stat = fs.statSync(full, { throwIfNoEntry: false });
        return { full, ts: stat ? stat.mtimeMs : 0 };
      })
      .sort((a, b) => b.ts - a.ts);
    for (const { full } of dirs.slice(SCHEDULE_ARTIFACT_RETENTION)) {
      fs.rmSync(full, { recursive: true, force: true });
    }
  } catch (err) { console.error('pruneScheduleArtifacts:', err.message); }
}

// ---- Scheduled-run event fan-out -------------------------------------------
// An interactive run streams NDJSON straight down its own /api/run response.
// A scheduled run has no client to stream to, so it publishes the SAME event
// shapes here and every open UI renders them live — same log, same Gherkin step
// timeline, same pass/fail pills — instead of the run happening invisibly.
const runStreamClients = new Set();

function broadcastRunEvent(obj) {
  const frame = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of [...runStreamClients]) {
    if (res.writableEnded || res.destroyed) { runStreamClients.delete(res); continue; }
    try { res.write(frame); } catch (_) { runStreamClients.delete(res); }
  }
}

async function fireScheduledRun(schedule) {
  // One Playwright run at a time. Overlapping an interactive run would put two
  // bddgen processes into .features-gen at once; skip this fire and let the
  // next tick pick it up rather than corrupting the compiled specs.
  if (activeRun) {
    broadcastRunEvent({ type: 'sched_skipped', name: schedule.name, id: schedule.id, reason: 'another run is already in progress' });
    return;
  }
  if (!fs.existsSync(SCHEDULE_LOGS_DIR)) fs.mkdirSync(SCHEDULE_LOGS_DIR, { recursive: true });
  const logPath = path.join(SCHEDULE_LOGS_DIR, `${schedule.id}-${Date.now()}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  logStream.write(`\n=== Scheduled run: ${schedule.name} @ ${new Date().toISOString()} ===\n`);
  const args = ['playwright', 'test'];
  if (schedule.feature) args.push(`.features-gen/features/${schedule.feature}/`);
  if (schedule.project) {
    args.push(`--project=${schedule.project}`);
  } else {
    // Same reasoning as /api/run: a schedule saved with no project must not
    // start including the emulated device projects just because they exist.
    for (const name of desktopProjectNames) args.push(`--project=${name}`);
  }
  if (schedule.tagFilter) args.push(`--grep=${schedule.tagFilter}`);
  args.push('--grep-invert=@destructive');
  // Isolate scheduled-run artifacts from the INTERACTIVE gallery and reports.
  // A schedule can fire every minute and (with empty feature/project) run the
  // whole matrix across every browser; without isolation those screenshots pile
  // into test-results/ and the gallery shows dozens of unrelated shots after any
  // interactive run. Route scheduled artifacts to a separate output dir and use
  // the lightweight `line` reporter so scheduled runs never overwrite
  // test-results/, results.json, playwright-report/ or allure-results/.
  args.push(`--output=${path.basename(SCHEDULE_OUTPUT_DIR)}`);
  // `line` for the durable log tail we parse tallies from, plus the live-step
  // reporter so a scheduled run drives the UI's Gherkin step timeline exactly
  // like an interactive one. The step reporter only writes [LIVE_STEP] lines to
  // stdout — it produces no files, so artifact isolation is unaffected.
  args.push('--reporter=line,./ui/live-step-reporter.js');
  // Headless unless the schedule opts in. Opting in means "let me watch the
  // real browsers run at the scheduled time"; it stays off by default because
  // an unattended every-N-minutes schedule that pops browser windows and
  // steals focus is unusable.
  if (schedule.headed) {
    args.push('--headed');
    // Mirror /api/run: one window for a single project, otherwise a worker per
    // project so they come up together instead of one at a time.
    args.push(`--workers=${schedule.project ? 1 : desktopProjectNames.length}`);
  }
  // Fan-out writer: the log file keeps the durable record (and feeds the tally
  // parser), while the SSE hub drives any open UI. Reusing runBddgen /
  // runPlaywrightProcess means scheduled runs emit byte-identical event shapes
  // to interactive ones, so the browser needs no special-case rendering.
  let tail = '';
  const write = (obj) => {
    if (obj && obj.type === 'log' && obj.text) {
      logStream.write(obj.text);
      tail = (tail + obj.text).slice(-8000);
    }
    broadcastRunEvent({ ...obj, scheduled: true, scheduleId: schedule.id });
  };

  broadcastRunEvent({
    type: 'sched_start',
    id: schedule.id,
    name: schedule.name,
    feature: schedule.feature || 'all features',
    project: schedule.project || desktopProjectNames.join(' + '),
    headed: !!schedule.headed,
  });

  let code = 1;
  let watchdog = null;
  let timedOut = false;
  try {
    await runBddgen(write);
    write({ type: 'start', cmd: 'npx ' + args.join(' '), cwd: ROOT });
    code = await runPlaywrightProcess(args, write, (p) => {
      // Hold the run lock so an interactive Run is refused (409) rather than
      // colliding, and so the Stop button can kill a visible scheduled run.
      activeRun = { proc: p, startedAt: Date.now(), scheduleId: schedule.id };
      // Release valve for the lock above. Without this, one wedged run blocks
      // the runner permanently — and a run that never exits is exactly what
      // happens when a short interval stacks headed runs against a slow app.
      watchdog = setTimeout(() => {
        timedOut = true;
        write({
          type: 'log',
          stream: 'stderr',
          text: `[ui] scheduled run exceeded ${SCHEDULE_RUN_MAX_MS < 60_000 ? `${Math.round(SCHEDULE_RUN_MAX_MS / 1000)}s` : `${Math.round(SCHEDULE_RUN_MAX_MS / 60000)} min`} — killing it (and its browsers) so later runs are not blocked\n`,
        });
        killProcessTree(p);
      }, SCHEDULE_RUN_MAX_MS);
    });
  } catch (err) {
    write({ type: 'log', stream: 'stderr', text: `[ui] scheduled run failed: ${err && err.message}\n` });
  } finally {
    if (watchdog) clearTimeout(watchdog);
    activeRun = null;
    logStream.write(`\n=== exit code ${code}${timedOut ? ' (killed: exceeded time limit)' : ''} ===\n`);
    logStream.end();
  }

  const stats = parseRunSummary(tail);
  const list = loadSchedules();
  const s = list.find((x) => x.id === schedule.id);
  if (s) {
    s.lastRun = Date.now();
    s.lastRunExitCode = code;
    // null when the run produced no summary (crash / bddgen failure) — the
    // card falls back to the bare ✓/✗ in that case.
    s.lastRunStats = stats;
    s.nextRun = computeNextRun(s, s.lastRun);
    saveSchedules(list);
  }
  pruneScheduleLogs(schedule.id);
  pruneScheduleArtifacts();
  broadcastRunEvent({ type: 'sched_done', id: schedule.id, name: schedule.name, exitCode: code, stats });
  // Tell someone when an unattended run goes red. Fire-and-forget: a webhook
  // that is down must never wedge the scheduler or hold the run lock.
  notifyScheduleFailure(schedule, code, stats).catch(() => {});
}

/**
 * POST a failure summary to the schedule's webhook.
 *
 * Only fires on failure — a green run every 15 minutes is noise, and noise is
 * how people learn to ignore alerts. Never throws: the caller is the scheduler.
 */
async function notifyScheduleFailure(schedule, exitCode, stats) {
  const url = schedule && schedule.webhookUrl;
  if (!url || !isHttpUrl(url)) return;
  const failed = (stats && (stats.failed || stats.flaky)) || 0;
  if (exitCode === 0 && !failed) return;

  const payload = {
    event: 'scheduled_run_failed',
    schedule: { id: schedule.id, name: schedule.name, feature: schedule.feature || '(all)', project: schedule.project || '(desktop browsers)' },
    exitCode,
    // stats is null when the run died before reporting (crash, bddgen failure).
    summary: stats || null,
    text: stats
      ? `QA scheduled run "${schedule.name}" failed — ${stats.failed || 0} failed, ${stats.flaky || 0} flaky, ${stats.passed || 0} passed (${stats.duration || 'n/a'})`
      : `QA scheduled run "${schedule.name}" failed before reporting (exit ${exitCode})`,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    console.log(`[schedule] webhook for "${schedule.name}" -> ${resp.status}`);
  } catch (err) {
    console.error(`[schedule] webhook for "${schedule.name}" failed: ${err && err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

setInterval(() => {
  try {
    const list = loadSchedules();
    if (!list.length) return;
    const now = Date.now();
    let mutated = false;
    for (const s of list) {
      if (!s.enabled) continue;
      if (!s.nextRun) { s.nextRun = computeNextRun(s, now); mutated = true; }
      if (s.nextRun <= now) {
        fireScheduledRun(s);
        // Push nextRun forward immediately so we don't double-fire in the same tick.
        s.nextRun = computeNextRun(s, now);
        mutated = true;
      }
    }
    if (mutated) saveSchedules(list);
  } catch (err) { console.error('scheduler tick:', err.message); }
}, SCHEDULE_TICK_MS);

app.get('/api/schedules', (_req, res) => {
  const list = loadSchedules();
  const enriched = list.map((s) => ({
    ...s,
    humanFrequency: humanFrequency(s),
  }));
  res.json({ schedules: enriched, tickMs: SCHEDULE_TICK_MS });
});

app.post('/api/schedules', (req, res) => {
  const { id, name, feature, project, tagFilter, mode, intervalMinutes, hour, minute, dayOfWeek, enabled, headed, webhookUrl } = req.body || {};
  if (!name || typeof name !== 'string' || name.length > 80) {
    return res.status(400).json({ error: 'name required (max 80 chars)' });
  }
  if (feature && !isSafeName(feature)) return res.status(400).json({ error: `feature must match ${SAFE_NAME_RE}` });
  if (project && !isSafeName(project)) return res.status(400).json({ error: `project must match ${SAFE_NAME_RE}` });
  if (tagFilter && typeof tagFilter !== 'string') return res.status(400).json({ error: 'tagFilter must be a string' });
  if (tagFilter && tagFilter.length > 200) return res.status(400).json({ error: 'tagFilter too long' });
  if (tagFilter && !/^[@A-Za-z0-9_.\s\-()!&|]+$/.test(tagFilter)) {
    return res.status(400).json({ error: 'tagFilter contains invalid characters (allowed: letters, digits, @, _, -, ., spaces, boolean ops)' });
  }
  if (headed !== undefined && headed !== null && typeof headed !== 'boolean') {
    return res.status(400).json({ error: 'headed must be a boolean' });
  }
  if (webhookUrl) {
    if (typeof webhookUrl !== 'string' || !isHttpUrl(webhookUrl)) {
      return res.status(400).json({ error: 'webhookUrl must be a valid http(s) URL' });
    }
    if (webhookUrl.length > 2048) return res.status(400).json({ error: 'webhookUrl too long' });
  }
  if (!['interval', 'daily', 'weekly'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be interval / daily / weekly' });
  }
  if (mode === 'interval') {
    const n = Number(intervalMinutes);
    if (!Number.isFinite(n) || n < 1 || n > 10080) return res.status(400).json({ error: 'intervalMinutes must be 1..10080' });
  }
  if (mode === 'daily' || mode === 'weekly') {
    const h = Number(hour), m = Number(minute);
    if (!Number.isInteger(h) || h < 0 || h > 23) return res.status(400).json({ error: 'hour must be 0..23' });
    if (!Number.isInteger(m) || m < 0 || m > 59) return res.status(400).json({ error: 'minute must be 0..59' });
  }
  if (mode === 'weekly') {
    const d = Number(dayOfWeek);
    if (!Number.isInteger(d) || d < 0 || d > 6) return res.status(400).json({ error: 'dayOfWeek must be 0..6 (Sun..Sat)' });
  }
  const list = loadSchedules();
  const record = {
    id: id || `sch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: name.trim(),
    feature: feature || '',
    project: project || '',
    tagFilter: tagFilter || '',
    mode,
    intervalMinutes: mode === 'interval' ? Number(intervalMinutes) : undefined,
    hour: (mode === 'daily' || mode === 'weekly') ? Number(hour) : undefined,
    minute: (mode === 'daily' || mode === 'weekly') ? Number(minute) : undefined,
    dayOfWeek: mode === 'weekly' ? Number(dayOfWeek) : undefined,
    enabled: enabled !== false,
    // Opt-in visible browsers for this schedule's runs.
    headed: headed === true,
    // Optional: POST a summary here when this schedule's run fails.
    webhookUrl: webhookUrl || '',
    createdAt: Date.now(),
  };
  record.nextRun = computeNextRun(record, Date.now());
  const existingIdx = list.findIndex((s) => s.id === record.id);
  if (existingIdx >= 0) {
    // Preserve lastRun/exitCode/stats on update
    record.lastRun = list[existingIdx].lastRun;
    record.lastRunExitCode = list[existingIdx].lastRunExitCode;
    record.lastRunStats = list[existingIdx].lastRunStats;
    record.createdAt = list[existingIdx].createdAt;
    list[existingIdx] = record;
  } else {
    list.push(record);
  }
  saveSchedules(list);
  // Non-blocking advice. A short interval does not break anything now that a
  // fire is skipped while another run holds the lock, but the user should know
  // most fires will be no-ops — and that a headed run of the whole suite opens
  // a browser window per worker.
  const warnings = [];
  if (record.mode === 'interval' && record.intervalMinutes < 10) {
    const scope = record.feature ? `the "${record.feature}" feature` : 'every feature';
    warnings.push(`Every ${record.intervalMinutes} min is shorter than a typical run of ${scope}. Overlapping fires are skipped, so most ticks will do nothing — consider 15-30 min.`);
  }
  if (record.headed) {
    const windows = record.project ? 1 : desktopProjectNames.length;
    warnings.push(`Visible mode opens ${windows} browser window${windows === 1 ? '' : 's'} (each is ~8 OS processes) every time this fires.`);
  }
  res.json({ ok: true, schedule: { ...record, humanFrequency: humanFrequency(record) }, warnings });
});

app.delete('/api/schedules/:id', (req, res) => {
  const id = String(req.params.id || '');
  if (!SCHEDULE_ID_RE.test(id)) return res.status(400).json({ error: 'invalid schedule id' });
  const list = loadSchedules();
  const filtered = list.filter((s) => s.id !== id);
  if (filtered.length === list.length) return res.status(404).json({ error: 'schedule not found' });
  saveSchedules(filtered);
  res.json({ ok: true, deleted: id });
});

// A scheduled run never streams to a client — its output goes to
// reports/scheduled-runs/<id>-<ts>.log and nothing read those files back, so the
// only feedback in the UI was a ✓/✗ on the card. These two routes make the runs
// inspectable: a list of recent runs, and the body of one of them.
app.get('/api/schedules/:id/logs', (req, res) => {
  const id = String(req.params.id || '');
  if (!SCHEDULE_ID_RE.test(id)) return res.status(400).json({ error: 'invalid schedule id' });
  try {
    if (!fs.existsSync(SCHEDULE_LOGS_DIR)) return res.json({ logs: [], retention: SCHEDULE_LOG_RETENTION });
    const prefix = `${id}-`;
    const logs = fs.readdirSync(SCHEDULE_LOGS_DIR)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.log'))
      .map((f) => {
        const ts = Number(f.slice(prefix.length, -4)) || 0;
        const stat = fs.statSync(path.join(SCHEDULE_LOGS_DIR, f), { throwIfNoEntry: false });
        return { ts, size: stat ? stat.size : 0 };
      })
      .filter((l) => l.ts > 0)
      .sort((a, b) => b.ts - a.ts);
    res.json({ logs, retention: SCHEDULE_LOG_RETENTION });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message) });
  }
});

app.get('/api/schedules/:id/logs/:ts', (req, res) => {
  const id = String(req.params.id || '');
  const ts = String(req.params.ts || '');
  if (!SCHEDULE_ID_RE.test(id)) return res.status(400).json({ error: 'invalid schedule id' });
  if (!/^\d+$/.test(ts)) return res.status(400).json({ error: 'invalid timestamp' });
  // Both segments are pattern-validated and the filename is rebuilt from them,
  // so no caller-supplied path can escape SCHEDULE_LOGS_DIR.
  const file = path.join(SCHEDULE_LOGS_DIR, `${id}-${ts}.log`);
  try {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) return res.status(404).json({ error: 'log not found' });
    let content = fs.readFileSync(file, 'utf8');
    let truncated = false;
    if (content.length > SCHEDULE_LOG_MAX_BYTES) {
      // Keep the tail: the summary and any failure output are at the end.
      content = content.slice(-SCHEDULE_LOG_MAX_BYTES);
      truncated = true;
    }
    content = stripTerminalControl(content);
    res.json({
      ts: Number(ts),
      size: stat.size,
      truncated,
      summary: parseRunSummary(content),
      content,
    });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message) });
  }
});

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
      // Normalize the title so history recorded with a path-y fullTitle (older
      // runs) groups with the clean-title runs for the same test.
      const key = `${e.feature}|${e.project}|${cleanTestTitle(e.fullTitle)}`;
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

      // Recency gate: a test that flipped historically but has been green for
      // its last few runs has stabilized — it's not *currently* flaky. Only
      // surface tests with at least one non-pass in the recent window, so the
      // count reflects live instability rather than long-healed history.
      const recentWindow = Math.min(8, window.length);
      const recentlyUnstable = window.slice(-recentWindow).some((r) => r.status !== 'passed');

      // Real flaky tests: at least minFlips status flips AND pass-rate not 0 or 1,
      // OR Playwright already marked it flaky at least once — AND it's been
      // unstable recently (not stabilized).
      if (recentlyUnstable && ((flips >= minFlips && passRate > 0 && passRate < 1) || flakyStatusCount > 0)) {
        const last = runs[runs.length - 1];
        flaky.push({
          fullTitle: cleanTestTitle(last.fullTitle) || last.fullTitle,
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

// Reset local run/flaky history — clears the accumulated per-test history
// (flaky detection) and the per-run summaries (status-bar sparkline). Both are
// gitignored, per-machine, and rebuild automatically on the next run. Used by
// the "reset history" action on the flaky pill.
app.post('/api/reset-history', (_req, res) => {
  const removed = [];
  for (const f of ['test-history.jsonl', 'history.jsonl']) {
    const p = path.join(CFG_PATHS.reports, f);
    try {
      if (fs.existsSync(p)) { fs.rmSync(p); removed.push(f); }
    } catch (err) {
      return res.status(500).json({ error: `could not remove ${f}: ${err.message}`, removed });
    }
  }
  res.json({ ok: true, removed });
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
            fullTitle: cleanTestTitle([...titles, spec.title].filter(Boolean).join(' › ')),
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
  const { feature, features, project, headed, lastFailed, tagFilter } = req.body || {};

  // Validate input. Empty/undefined feature = run all features (no path arg);
  // any provided feature/project must match the safe-name regex AND, for
  // feature, refer to a real folder under features/ or tests/.
  // `features` (array) is used by "Run N impacted features" — validate each entry.
  let featuresArr = null;
  if (features !== undefined && features !== null && !Array.isArray(features)) {
    return res.status(400).json({ error: 'features must be an array of feature names' });
  }
  if (Array.isArray(features) && features.length > 0) {
    if (features.length > 50) return res.status(400).json({ error: 'features array too long (max 50)' });
    for (const f of features) {
      if (typeof f !== 'string' || !isSafeName(f)) {
        return res.status(400).json({ error: `each features entry must match ${SAFE_NAME_RE} (got "${f}")` });
      }
      const inFeatures = fs.existsSync(path.join(ROOT, 'features', f));
      const inTests = fs.existsSync(path.join(CFG_PATHS.tests, f));
      if (!inFeatures && !inTests) {
        return res.status(404).json({ error: `feature "${f}" does not exist under features/ or tests/` });
      }
    }
    featuresArr = features;
  }
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
  } else if (featuresArr) {
    // Multiple features (e.g. "Run N impacted features") — Playwright accepts
    // several positional test-dir args in one invocation.
    for (const f of featuresArr) args.push(`.features-gen/features/${f}/`);
  } else if (feature) {
    // Specific feature picked → filter the BDD compiled tests by feature dir.
    args.push(`.features-gen/features/${feature}/`);
  }
  if (project) {
    args.push(`--project=${project}`);
  } else {
    // No project = the UI's "All browsers" matrix: every configured project,
    // desktop browsers AND emulated devices, in one pass. Named explicitly
    // rather than relying on Playwright's "run all projects" default so the
    // set the UI advertises is the set that actually runs.
    for (const name of projectNames) args.push(`--project=${name}`);
  }
  // Optional tag filter (Playwright supports boolean expressions like "@smoke and not @slow").
  if (tagFilter && typeof tagFilter === 'string' && tagFilter.trim()) {
    const clean = tagFilter.trim();
    if (clean.length > 200 || !/^[@A-Za-z0-9_.\s\-()!&|]+$/.test(clean)) {
      return res.status(400).json({ error: 'tagFilter contains invalid characters or is too long' });
    }
    args.push(`--grep=${clean}`);
  }
  // Default-skip @destructive tag (e.g. signup AC1/AC2 that creates real
  // tenants on prod, or order-flow that submits real vendor orders). Override
  // with `destructive: true` in the request body. The UI no longer sends that
  // flag at all — the opt-in checkbox was removed — so an interactive run
  // always skips them; `npm run test:destructive` is the deliberate path. The
  // branch stays for API callers that opt in explicitly.
  if (!req.body?.destructive) {
    args.push('--grep-invert=@destructive');
  } else {
    // Destructive scenarios submit real, persistent data. Force retries=0 so a
    // transient failure can never re-run and double-submit (e.g. send the same
    // orders twice) — matches the safety note in the destructive .feature files.
    args.push('--retries=0');
  }
  if (headed !== false) {
    args.push('--headed');
    if (project) {
      // Single project headed: one worker so you can follow the run in one
      // window instead of 8 windows of the same browser fighting for focus.
      args.push('--workers=1');
    } else {
      // Headed matrix: the whole point is watching every browser and device
      // side by side, so clamping to one worker would defeat it — the projects
      // would open one at a time. Playwright interleaves projects across
      // workers (measured: 4 distinct engines starting inside 80ms with 7
      // workers), so a worker per project gets them all up together. It does
      // not guarantee a strict one-window-per-project ordering — the scheduler
      // decides which test each free worker picks up.
      args.push(`--workers=${projectNames.length}`);
    }
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
    // Remove stale per-test artifact folders so the screenshot gallery reflects
    // ONLY this run (Playwright leaves prior runs' folders in place otherwise).
    cleanTestArtifacts(write);
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

// Live event stream for runs the browser did not start itself — currently
// scheduled runs. Server-Sent Events rather than a WebSocket: the traffic is
// one-way, EventSource reconnects on its own, and it needs no extra dependency.
app.get('/api/run-stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Defeat proxy buffering, which would otherwise hold events until the socket
  // closed — the exact opposite of "live".
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();
  res.write(': connected\n\n');
  runStreamClients.add(res);
  // Comment-only heartbeat keeps idle intermediaries from dropping the socket.
  const beat = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    try { res.write(': ping\n\n'); } catch (_) { /* pruned on next broadcast */ }
  }, 20_000);
  const cleanup = () => { clearInterval(beat); runStreamClients.delete(res); };
  req.on('close', cleanup);
  res.on('close', cleanup);
});

// The runnable Playwright projects, so the UI's browser dropdowns are built
// from the same list playwright.config.js uses instead of a hardcoded copy.
// `kind` lets the UI group desktop browsers apart from emulated devices.
app.get('/api/projects', (_req, res) => {
  res.json({
    projects: ALL_PROJECTS.map((p) => ({ name: p.name, label: p.label, kind: p.kind })),
    // What "All browsers" runs: every project, desktop + emulated devices.
    matrix: projectNames,
    // What a schedule saved with no explicit browser runs — deliberately just
    // the desktop three, so an unattended every-N-minutes schedule doesn't
    // quietly run the full 7-project matrix against the live app.
    scheduleDefault: desktopProjectNames,
  });
});

app.get('/api/report-status', (_req, res) => {
  try {
    const allReports = fs.existsSync(CFG_PATHS.reports) ? fs.readdirSync(CFG_PATHS.reports) : [];
    const mdReports = allReports.filter((f) => f.endsWith('.md'));
    // reports/ keeps every report ever generated, so a flat listing puts a
    // report from a run weeks ago next to the one you just produced with no way
    // to tell them apart. Work out which features actually ran last so the UI
    // can lead with those and fold the rest away.
    const features = featuresFromLastRun({ root: ROOT, paths: CFG_PATHS });
    const lastRunReports = features
      ? mdReports.filter((f) => [...features].some((slug) => reportMatchesFeature(f, slug)))
      // null (not []) when the last run is unknown — no results.json yet, or a
      // run in flight. The UI must show everything rather than hide reports.
      : null;
    const reportTimes = {};
    for (const f of allReports) {
      const stat = fs.statSync(path.join(CFG_PATHS.reports, f), { throwIfNoEntry: false });
      if (stat && stat.isFile()) reportTimes[f] = stat.mtimeMs;
    }
    res.json({
      playwright: fs.existsSync(path.join(CFG_PATHS.playwrightReport, 'index.html')),
      allure: fs.existsSync(path.join(CFG_PATHS.allureReport, 'index.html')),
      aiReports: mdReports,
      excelReports: allReports.filter((f) => f.endsWith('.xlsx')),
      lastRunReports,
      lastRunFeatures: features ? [...features] : null,
      reportTimes,
    });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message) });
  }
});

// ---- Security scanner ------------------------------------------------------
// Validate a target is a real http(s) URL before we make requests to it.
function isHttpUrl(s) {
  try { const u = new URL(String(s)); return u.protocol === 'http:' || u.protocol === 'https:'; }
  catch { return false; }
}

// POST /api/security-scan — streams progress as NDJSON, ends with the full
// result ({type:'result'}) and a {type:'done'}. Reuses the lib/security engine.
app.post('/api/security-scan', async (req, res) => {
  const { target, passive, active, probeFiles, zap } = req.body || {};
  if (!isHttpUrl(target)) return res.status(400).json({ error: 'target must be a valid http(s) URL' });

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.on('error', () => {});
  const write = makeSafeWrite(res);
  write({ type: 'start', target });
  try {
    const result = await security.runSecurityScan(target, {
      passive: passive !== false,
      active: active !== false,
      probeFiles: !!probeFiles,
      zap: !!zap,
      reportsDir: CFG_PATHS.reports,
      startedAt: new Date().toISOString(),
      onLog: (m) => write({ type: 'log', stream: 'stdout', text: m + '\n' }),
    });
    write({ type: 'result', result });
    write({ type: 'done', exitCode: 0 });
  } catch (err) {
    write({ type: 'log', stream: 'stderr', text: `[security] scan failed: ${err.message}\n` });
    write({ type: 'done', exitCode: 1 });
  }
  if (!res.writableEnded) res.end();
});

// GET /api/security-report — the last persisted scan (reports/security/latest.json).
app.get('/api/security-report', (_req, res) => {
  try {
    const p = path.join(CFG_PATHS.reports, 'security', 'latest.json');
    if (!fs.existsSync(p)) return res.json({ exists: false });
    res.json({ exists: true, result: JSON.parse(fs.readFileSync(p, 'utf8')) });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message) });
  }
});

// POST /api/security-review — Claude turns the latest findings into a
// prioritized remediation plan. Reuses the shared streamClaudeWithPrompt path.
app.post('/api/security-review', async (req, res) => {
  const claudeOk = await checkClaudeCli();
  if (!claudeOk) return res.status(501).json({ error: 'claude CLI not found on PATH' });
  if (activeGenerate) return res.status(409).json({ error: 'another Claude job is in progress' });
  let result = req.body && req.body.result;
  if (!result) {
    const p = path.join(CFG_PATHS.reports, 'security', 'latest.json');
    if (fs.existsSync(p)) { try { result = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) {} }
  }
  if (!result || !Array.isArray(result.findings)) {
    return res.status(400).json({ error: 'no scan findings available — run a scan first' });
  }
  await streamClaudeWithPrompt(res, security.buildReviewPrompt(result));
});

// ---- Step index ------------------------------------------------------------

// GET /api/steps — every step definition that already exists, with tag scope.
// Cheap (plain file parsing, no AI) and the basis for skipping AI calls when a
// step is already implemented.
app.get('/api/steps', (_req, res) => {
  try {
    const index = stepIndex.readStepIndex({ root: ROOT });
    res.json({
      files: index.files,
      count: index.steps.length,
      byScope: index.byScope,
      duplicates: stepIndex.findDuplicates(index),
      // Paste-ready library for the generation prompt, so Claude does not spend
      // round trips grepping the repo to find out what already exists.
      promptBlock: stepIndex.renderLibraryForPrompt(index),
      steps: index.steps,
    });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message) });
  }
});

// POST /api/steps/match — which steps already have definitions, and which
// genuinely need code written.
//
// This is the fast path: a step that matches an existing definition (exactly,
// or through its {string} placeholders) needs NO Claude call. Only the ones
// that come back "none" do. Answers in milliseconds.
//
// Body: { feature: "<slug>" }  or  { gherkin: "<feature text>" }
//       plus optional { tags: ["@login"] } when passing raw gherkin.
app.post('/api/steps/match', (req, res) => {
  const { feature, gherkin, tags } = req.body || {};
  let src = gherkin;

  if (!src) {
    if (!feature) return res.status(400).json({ error: 'provide feature or gherkin' });
    if (!isSafeName(feature)) return res.status(400).json({ error: `feature must match ${SAFE_NAME_RE}` });
    const dir = path.join(CFG_PATHS.features || path.join(ROOT, 'features'), feature);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: `feature "${feature}" not found` });
    let picked = null;
    try {
      picked = fs.readdirSync(dir).find((f) => f.endsWith('.feature') && !f.startsWith('_'));
    } catch { /* handled below */ }
    if (!picked) return res.status(404).json({ error: `no .feature file in features/${feature}` });
    try { src = fs.readFileSync(path.join(dir, picked), 'utf8'); }
    catch (err) { return res.status(500).json({ error: String(err && err.message) }); }
  }

  if (typeof src !== 'string' || !src.trim()) return res.status(400).json({ error: 'gherkin is empty' });
  if (src.length > 200_000) return res.status(413).json({ error: 'gherkin too large' });

  try {
    const index = stepIndex.readStepIndex({ root: ROOT });
    const analysis = stepIndex.analyzeFeature(src, index);
    // Caller-supplied tags win when raw gherkin carries none of its own.
    if (Array.isArray(tags) && tags.length && !analysis.tags.length) {
      const re = stepIndex.analyzeFeature(
        tags.map((t) => String(t)).join(' ') + '\n' + src,
        index
      );
      return res.json({ ...re, needsAi: re.results.filter((r) => r.status === 'none').map((r) => r.text) });
    }
    res.json({ ...analysis, needsAi: analysis.results.filter((r) => r.status === 'none').map((r) => r.text) });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message) });
  }
});

// ---- Exploratory testing ---------------------------------------------------

// One crawl at a time. A crawl drives its own Chromium independently of a
// Playwright test run, so it does NOT take the activeRun lock — but two
// concurrent crawls would fight over reports/exploration/latest.json.
let activeExplore = false;

// POST /api/explore/run — crawl the live app and diff it against the suite.
//
// Credentials: taken from the request, falling back to QA_EMAIL / QA_PASSWORD.
// They are passed straight to the engine and never persisted or echoed — the
// only thing written to the stream is the engine's own log lines, which carry
// no secrets, and the report on disk contains no credentials.
app.post('/api/explore/run', async (req, res) => {
  const { baseUrl, email, password, mode, maxRoutes } = req.body || {};
  if (!isHttpUrl(baseUrl)) return res.status(400).json({ error: 'baseUrl must be a valid http(s) URL' });
  if (String(baseUrl).length > 2048) return res.status(400).json({ error: 'baseUrl too long' });
  const em = email || process.env.QA_EMAIL;
  const pw = password || process.env.QA_PASSWORD;
  if (!em || !pw) {
    return res.status(400).json({ error: 'credentials required — enter them here or set QA_EMAIL / QA_PASSWORD' });
  }
  if (mode !== undefined && !['passive', 'guarded'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be passive or guarded' });
  }
  let cap;
  if (maxRoutes !== undefined && maxRoutes !== null && maxRoutes !== '') {
    cap = Number(maxRoutes);
    if (!Number.isFinite(cap) || cap < 1 || cap > 60) {
      return res.status(400).json({ error: 'maxRoutes must be between 1 and 60' });
    }
  }
  if (activeExplore) return res.status(409).json({ error: 'an exploratory crawl is already running' });

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.on('error', () => {});
  const write = makeSafeWrite(res);
  activeExplore = true;
  write({ type: 'start', baseUrl, mode: mode || 'guarded' });
  try {
    const result = await explore.runExploration({
      root: ROOT,
      baseUrl,
      email: em,
      password: pw,
      mode: mode || 'guarded',
      maxRoutes: cap,
      reportsDir: CFG_PATHS.reports,
      startedAt: new Date().toISOString(),
      onLog: (m) => write({ type: 'log', stream: 'stdout', text: m + '\n' }),
    });
    write({
      type: 'result',
      ok: !!result.ok,
      error: result.error || null,
      summary: result.ok ? result.analysis.summary : null,
      groups: result.ok ? result.analysis.findingGroups : [],
      routeReports: result.ok ? result.analysis.routeReports : [],
    });
    write({ type: 'done', exitCode: result.ok ? 0 : 1 });
  } catch (err) {
    write({ type: 'log', stream: 'stderr', text: `[explore] crawl failed: ${err.message}\n` });
    write({ type: 'result', ok: false, error: String(err && err.message) });
    write({ type: 'done', exitCode: 1 });
  } finally {
    activeExplore = false;
    if (!res.writableEnded) res.end();
  }
});

// GET /api/explore/report — the latest crawl's surface map + ranked gaps.
app.get('/api/explore/report', (_req, res) => {
  const p = path.join(CFG_PATHS.reports, 'exploration', 'latest.json');
  if (!fs.existsSync(p)) return res.json({ available: false });
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    const stat = fs.statSync(p, { throwIfNoEntry: false });
    res.json({
      available: true,
      ranAt: stat ? stat.mtimeMs : null,
      mode: data.crawl && data.crawl.mode,
      traversal: data.crawl && data.crawl.traversal,
      summary: data.analysis && data.analysis.summary,
      groups: (data.analysis && data.analysis.findingGroups) || [],
      routeReports: (data.analysis && data.analysis.routeReports) || [],
    });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message) });
  }
});

// POST /api/explore/draft — Claude drafts Gherkin for the top gaps. Reuses the
// same streamClaudeWithPrompt path as generate/heal/security-review, so it
// obeys the single-Claude-job lock and streams into the existing log viewer.
//
// The prompt (lib/explore/index.js buildScenarioPrompt) constrains it hard:
// drafts go to specs/ for review, never straight into .feature files, and it is
// told not to draft anything that mutates data — destructive gaps are listed
// for a human to write with the @destructive tag this repo already uses.
app.post('/api/explore/draft', async (req, res) => {
  const claudeOk = await checkClaudeCli();
  if (!claudeOk) return res.status(501).json({ error: 'claude CLI not found on PATH' });
  if (activeGenerate) return res.status(409).json({ error: 'another Claude job is in progress' });
  let payload = req.body && req.body.result;
  if (!payload) {
    const p = path.join(CFG_PATHS.reports, 'exploration', 'latest.json');
    if (fs.existsSync(p)) { try { payload = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) {} }
  }
  if (!payload || !payload.analysis || !Array.isArray(payload.analysis.findings)) {
    return res.status(400).json({ error: 'no exploration findings available — run a crawl first' });
  }
  await streamClaudeWithPrompt(res, explore.buildScenarioPrompt(payload.crawl, payload.analysis));
});

// ---- API testing -----------------------------------------------------------
app.get('/api/api-test/suites', (_req, res) => {
  try { res.json({ suites: apiTesting.listSuites(ROOT) }); }
  catch (err) { res.status(500).json({ error: String(err && err.message) }); }
});

app.post('/api/api-test/run', async (req, res) => {
  const { file } = req.body || {};
  // Suite filename must be a plain <name>.json under api-tests/ — no traversal.
  if (!file || typeof file !== 'string' || file.includes('/') || file.includes('\\') || file.includes('..') || !/^[A-Za-z0-9._-]+\.json$/.test(file)) {
    return res.status(400).json({ error: 'file must be a .json suite name under api-tests/' });
  }
  if (!fs.existsSync(path.join(ROOT, 'api-tests', file))) {
    return res.status(404).json({ error: `suite not found: api-tests/${file}` });
  }
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.on('error', () => {});
  const write = makeSafeWrite(res);
  try {
    const suite = apiTesting.loadSuite(ROOT, file);
    const summary = await apiTesting.runSuite(suite, {
      onLog: (m) => write({ type: 'log', stream: 'stdout', text: m + '\n' }),
      now: () => Date.now(),
    });
    write({ type: 'result', summary });
    write({ type: 'done', exitCode: summary.failed > 0 ? 1 : 0 });
  } catch (err) {
    write({ type: 'log', stream: 'stderr', text: `[api] ${err.message}\n` });
    write({ type: 'done', exitCode: 1 });
  }
  if (!res.writableEnded) res.end();
});

// ---- Performance budgets ---------------------------------------------------
app.get('/api/perf/budgets', (_req, res) => {
  try { res.json({ budget: perfEngine.loadBudget(ROOT) }); }
  catch (err) { res.status(500).json({ error: String(err && err.message) }); }
});

app.post('/api/perf/budgets', (req, res) => {
  try { res.json({ budget: perfEngine.saveBudget(ROOT, (req.body && req.body.budget) || {}) }); }
  catch (err) { res.status(500).json({ error: String(err && err.message) }); }
});

app.post('/api/perf/run', async (req, res) => {
  const { target } = req.body || {};
  if (!isHttpUrl(target)) return res.status(400).json({ error: 'target must be a valid http(s) URL' });
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.on('error', () => {});
  const write = makeSafeWrite(res);
  try {
    const result = await perfEngine.runPerf(target, {
      rootDir: ROOT,
      startedAt: new Date().toISOString(),
      onLog: (m) => write({ type: 'log', stream: 'stdout', text: m + '\n' }),
    });
    write({ type: 'result', result });
    write({ type: 'done', exitCode: result.passed ? 0 : 1 });
  } catch (err) {
    write({ type: 'log', stream: 'stderr', text: `[perf] ${err.message}\n` });
    write({ type: 'done', exitCode: 1 });
  }
  if (!res.writableEnded) res.end();
});

app.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`\nAgentic QA Pipeline UI: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}${HOST === '0.0.0.0' ? ' (also reachable on LAN)' : ''}\n`);
});
