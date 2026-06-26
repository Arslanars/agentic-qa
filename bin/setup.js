#!/usr/bin/env node
// `npm run setup` — bootstrap the framework after `git clone`.
// Idempotent: safe to re-run.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);

function step(label, fn) {
  console.log(`\n▶ ${label}`);
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    console.error(`  ✗ ${label}`);
    throw err;
  }
}

step('Install npm dependencies', () => {
  execSync('npm install', { stdio: 'inherit' });
});

step('Install Playwright browsers (chromium / firefox / webkit)', () => {
  execSync('npx playwright install', { stdio: 'inherit' });
});

step('Create .env from .env.example (if missing)', () => {
  const example = path.join(ROOT, 'templates', '.env.example');
  const target = path.join(ROOT, '.env');
  if (!fs.existsSync(example)) {
    console.log('    (no .env.example template found, skipping)');
    return;
  }
  if (fs.existsSync(target)) {
    console.log('    .env already exists, leaving it alone');
    return;
  }
  fs.copyFileSync(example, target);
  console.log('    .env created — fill in any per-feature credentials your tests need');
});

console.log(`
${'─'.repeat(64)}
  Setup complete.

  Next:
    npm run ui      # opens http://localhost:3001

  To author new tests, either:
    • use Claude Code with the prompt in QAEnd2EndPromptFile.md, or
    • hand-author POMs + specs following pages/README.md.
${'─'.repeat(64)}
`);
