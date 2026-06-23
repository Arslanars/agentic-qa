#!/usr/bin/env node
// agentic-qa — CLI entry.
//   agentic-qa init        Scaffold this framework into the current Playwright project
//   agentic-qa ui          Launch the local web UI (http://localhost:3001)
//   agentic-qa generate    Generate POM + spec files for a story (headless, for CI)
//   agentic-qa run         Run the existing Playwright suite

const cmd = process.argv[2];

const commands = {
  init: () => require('../lib/commands/init')(process.argv.slice(3)),
  ui: () => require('../lib/commands/ui')(process.argv.slice(3)),
  generate: () => require('../lib/commands/generate')(process.argv.slice(3)),
  run: () => require('../lib/commands/run')(process.argv.slice(3)),
  '--help': showHelp,
  '-h': showHelp,
  help: showHelp,
};

function showHelp() {
  console.log(`
agentic-qa — AI-powered QA pipeline for Playwright projects

Usage:
  npx agentic-qa <command> [options]

Commands:
  init        Scaffold the framework into the current project (one-time)
  ui          Launch the web UI at http://localhost:3001
  generate    Generate POM + spec files for a story (CLI, no UI)
  run         Run the existing Playwright suite

Examples:
  npx agentic-qa init
  npx agentic-qa ui
  npx agentic-qa generate --url https://app.com/login --story user-stories/LOGIN-001.md
  npx agentic-qa run --feature login --headed

Configuration:
  Reads ./agentic-qa.config.js (created by 'init') for paths, port, model.
  See: <repo>/templates/agentic-qa.config.js
`);
}

const handler = commands[cmd];
if (!handler) {
  if (cmd) console.error(`Unknown command: ${cmd}\n`);
  showHelp();
  process.exit(cmd ? 1 : 0);
}

Promise.resolve(handler()).catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
