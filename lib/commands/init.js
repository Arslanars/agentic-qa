// `agentic-qa init` — scaffolds the framework into an existing Playwright project.
//
// Idempotent and conservative: never overwrites existing files unless --force.
// Prints exactly which files changed and what the user still needs to do manually
// (the only manual step is patching their playwright.config.js — too risky to auto-edit).

const fs = require('fs');
const path = require('path');

const PKG_ROOT = path.resolve(__dirname, '../..');

function readJsonOrEmpty(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function copyIfMissing(src, dest, force, log) {
  if (fs.existsSync(dest) && !force) {
    log(`  -  ${path.relative(process.cwd(), dest)} (exists, skipped)`);
    return false;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  log(`  ✓  ${path.relative(process.cwd(), dest)}`);
  return true;
}

function copyDirIfMissing(srcDir, destDir, force, log) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirIfMissing(src, dest, force, log);
    } else {
      copyIfMissing(src, dest, force, log);
    }
  }
}

function ensureDir(p, log) {
  if (!fs.existsSync(p)) {
    fs.mkdirSync(p, { recursive: true });
    log(`  ✓  ${path.relative(process.cwd(), p)}/`);
  } else {
    log(`  -  ${path.relative(process.cwd(), p)}/ (exists)`);
  }
}

function appendGitignore(cwd, log) {
  const giPath = path.join(cwd, '.gitignore');
  const addPath = path.join(PKG_ROOT, 'templates', 'gitignore-additions.txt');
  if (!fs.existsSync(addPath)) return;
  const additions = fs.readFileSync(addPath, 'utf8');
  const existing = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf8') : '';
  if (existing.includes('agentic-qa runtime artifacts')) {
    log('  -  .gitignore (already has agentic-qa block)');
    return;
  }
  const joined = (existing.trimEnd() + '\n\n' + additions).trimStart();
  fs.writeFileSync(giPath, joined, 'utf8');
  log('  ✓  .gitignore (appended agentic-qa entries)');
}

function patchPackageJson(cwd, log) {
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    log('  !  No package.json found — skipping script patch. Run `npm init -y` first.');
    return;
  }
  const pkg = readJsonOrEmpty(pkgPath);
  pkg.scripts = pkg.scripts || {};
  const toAdd = {
    'qa': 'agentic-qa',
    'qa:ui': 'agentic-qa ui',
    'qa:generate': 'agentic-qa generate',
    'qa:run': 'agentic-qa run',
  };
  let changed = false;
  for (const [k, v] of Object.entries(toAdd)) {
    if (!pkg.scripts[k]) {
      pkg.scripts[k] = v;
      changed = true;
    }
  }
  if (changed) {
    writeJson(pkgPath, pkg);
    log('  ✓  package.json (added qa, qa:ui, qa:generate, qa:run scripts)');
  } else {
    log('  -  package.json (scripts already present)');
  }
}

function printPlaywrightSnippet() {
  console.log(`
${'─'.repeat(72)}
  MANUAL STEP — Patch your playwright.config.js
${'─'.repeat(72)}

Add these two reporters and two 'use' options. Existing reporters/use entries
stay; just merge these in.

  // At the top of the file, with your other imports:
  // (no new imports needed — these are built into your Playwright install)

  module.exports = defineConfig({
    // ...your existing config...

    reporter: [
      ['list'],
      ['html', { open: 'never' }],
      ['allure-playwright', { detail: true, outputFolder: 'allure-results', suiteTitle: false }],
    ],

    use: {
      // ...your existing use options...
      screenshot: 'on',           // gallery in the UI; on-failure also works
      video: 'retain-on-failure',
    },
  });

Then install the two new reporters as dev dependencies:

  npm install -D allure-playwright allure-commandline

(Java is required to render the Allure HTML locally — CI is unaffected.
 On Windows: \`winget install Microsoft.OpenJDK.21\`)
${'─'.repeat(72)}
`);
}

function printNextSteps(cwd) {
  console.log(`
${'─'.repeat(72)}
  NEXT STEPS
${'─'.repeat(72)}

  1. (Optional) Add your Anthropic API key to .env (for the UI Generate button):
       cp .env.example .env  &&  edit .env

  2. Start the UI:
       npm run qa:ui
       → http://localhost:${require('../config').DEFAULTS.uiPort}

  3. Drop a new story into user-stories/ and click ✨ Generate & Run.

  Full docs: <node_modules>/agentic-qa/ONBOARDING.md
${'─'.repeat(72)}
`);
}

module.exports = function init(args = []) {
  const force = args.includes('--force');
  const cwd = process.cwd();

  console.log(`\n🚀  Initializing agentic-qa in ${cwd}`);
  if (force) console.log('   (--force: existing files will be overwritten)\n');
  else console.log('   (existing files are preserved; pass --force to overwrite)\n');

  const log = (msg) => console.log(msg);

  // 1. agentic-qa.config.js
  copyIfMissing(
    path.join(PKG_ROOT, 'templates/agentic-qa.config.js'),
    path.join(cwd, 'agentic-qa.config.js'),
    force, log,
  );

  // 2. BasePage.ts (load config to find their actual pagesDir)
  const { loadConfig } = require('../config');
  const cfg = loadConfig(cwd);
  copyIfMissing(
    path.join(PKG_ROOT, 'templates/BasePage.ts'),
    path.join(cfg.paths.pages, 'BasePage.ts'),
    force, log,
  );

  // 3. Story / spec / report dirs (empty + .gitkeep)
  for (const dir of [cfg.paths.stories, cfg.paths.specs, cfg.paths.reports]) {
    ensureDir(dir, log);
    const keep = path.join(dir, '.gitkeep');
    if (!fs.existsSync(keep)) fs.writeFileSync(keep, '');
  }

  // 4. .claude/agents (planner / generator / healer prompts)
  copyDirIfMissing(
    path.join(PKG_ROOT, '.claude/agents'),
    path.join(cwd, '.claude/agents'),
    force, log,
  );

  // 5. .env.example
  copyIfMissing(
    path.join(PKG_ROOT, 'templates/.env.example'),
    path.join(cwd, '.env.example'),
    force, log,
  );

  // 6. .gitignore additions
  appendGitignore(cwd, log);

  // 7. package.json scripts
  patchPackageJson(cwd, log);

  // 8. Print manual playwright.config patch
  printPlaywrightSnippet();

  // 9. Next steps
  printNextSteps(cwd);
};
