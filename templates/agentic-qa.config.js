// agentic-qa configuration. All paths are relative to the project root.
// All keys are optional — what's shown here is the default. Delete any line
// you don't need to override.

module.exports = {
  // Where your tests live.
  testsDir: 'tests',

  // Where Page Object Model classes live.
  pagesDir: 'pages',

  // Where to write user-story markdown files (input to the pipeline).
  storiesDir: 'user-stories',

  // Where to write test plans (output of the planner).
  specsDir: 'specs',

  // Where to write AI-generated execution reports (committed to the repo).
  reportsDir: 'reports',

  // Port for the local web UI (`npx agentic-qa ui`).
  uiPort: 3001,

  // Claude model used by the in-UI Generate button.
  // Options: 'claude-opus-4-8' (default, most capable), 'claude-sonnet-4-6' (cheaper),
  // 'claude-haiku-4-5' (cheapest, simple forms only).
  model: 'claude-opus-4-8',

  // Path to your Playwright config (used to detect/patch reporters).
  playwrightConfig: 'playwright.config.js',
};
