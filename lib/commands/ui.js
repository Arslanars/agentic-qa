// `agentic-qa ui` — launch the Express UI server using the consumer's config.

const path = require('path');
const { loadConfig } = require('../config');

module.exports = function ui(args = []) {
  const cwd = process.cwd();
  const cfg = loadConfig(cwd);

  // Honor --port flag
  const portFlag = args.indexOf('--port');
  if (portFlag !== -1 && args[portFlag + 1]) {
    cfg.uiPort = Number(args[portFlag + 1]) || cfg.uiPort;
  }

  // Hand off to the existing server with config injected via env.
  process.env.UI_PORT = String(cfg.uiPort);
  process.env.AGENTIC_QA_CWD = cwd;
  process.env.AGENTIC_QA_CONFIG_JSON = JSON.stringify(cfg);

  // require() the server in-process so config is honored.
  require('../../ui/server.js');
};
