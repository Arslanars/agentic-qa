// Loads ./agentic-qa.config.js from the current working directory and
// resolves every path to an absolute path against cwd. All consumer
// configuration lives in one file at their project root.

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  testsDir: 'tests',
  pagesDir: 'pages',
  storiesDir: 'user-stories',
  specsDir: 'specs',
  reportsDir: 'reports',
  // These three live wherever Playwright/Allure put them — typically the project root.
  testResultsDir: 'test-results',
  allureResultsDir: 'allure-results',
  allureReportDir: 'allure-report',
  playwrightReportDir: 'playwright-report',
  uiPort: 3001,
  playwrightConfig: 'playwright.config.js',
};

function loadConfig(cwd = process.cwd()) {
  const configPath = path.join(cwd, 'agentic-qa.config.js');
  let userConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      // Bust require cache so re-runs see edits.
      delete require.cache[require.resolve(configPath)];
      userConfig = require(configPath);
    } catch (err) {
      console.error(`[agentic-qa] failed to load ${configPath}:`, err.message);
    }
  }

  const merged = { ...DEFAULTS, ...userConfig };
  const port = Number(process.env.UI_PORT) || merged.uiPort;

  const paths = {
    cwd,
    tests: path.resolve(cwd, merged.testsDir),
    pages: path.resolve(cwd, merged.pagesDir),
    stories: path.resolve(cwd, merged.storiesDir),
    specs: path.resolve(cwd, merged.specsDir),
    reports: path.resolve(cwd, merged.reportsDir),
    testResults: path.resolve(cwd, merged.testResultsDir),
    allureResults: path.resolve(cwd, merged.allureResultsDir),
    allureReport: path.resolve(cwd, merged.allureReportDir),
    playwrightReport: path.resolve(cwd, merged.playwrightReportDir),
  };

  return {
    cwd,
    paths,
    uiPort: port,
    playwrightConfig: merged.playwrightConfig,
    raw: merged,
  };
}

module.exports = { loadConfig, DEFAULTS };
