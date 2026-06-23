// `agentic-qa run` — thin wrapper around `npx playwright test`.
// Mostly for completeness; teams will normally use `npm run test` or `npx playwright test` directly.

const { spawn } = require('child_process');

module.exports = function run(args = []) {
  const playwrightArgs = ['playwright', 'test', ...args];
  console.log(`$ npx ${playwrightArgs.join(' ')}\n`);
  const proc = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', playwrightArgs, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  proc.on('close', (code) => process.exit(code || 0));
};
