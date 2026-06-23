// `agentic-qa generate` — headless test generation for CI / scripts.
//
// Reads either a story file (--story path) OR inline flags (--url, --title, --ac).
// Calls the same generator the UI uses, writes POM + specs into the configured dirs.

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../config');

function getArg(args, name, alias) {
  const i = args.findIndex(a => a === `--${name}` || a === `-${alias}`);
  return i !== -1 ? args[i + 1] : undefined;
}

module.exports = async function generate(args = []) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set in your environment. Aborting.');
    process.exit(1);
  }

  const url = getArg(args, 'url', 'u');
  const storyFile = getArg(args, 'story', 's');
  let title = getArg(args, 'title', 't');
  let ac = getArg(args, 'ac', 'a');
  let storyId = getArg(args, 'id');
  let story = '';
  const creds = getArg(args, 'creds', 'c') || '';

  if (!url) {
    console.error('Missing --url. Usage:');
    console.error('  agentic-qa generate --url https://app.com/login --story user-stories/LOGIN-001.md');
    console.error('  agentic-qa generate --url https://app.com/login --title "Login" --ac "AC1: ..."');
    process.exit(1);
  }

  if (storyFile) {
    const md = fs.readFileSync(path.resolve(process.cwd(), storyFile), 'utf8');
    // Extract title from first H1
    const h1 = md.match(/^#\s+(?:User Story:\s+)?(?:[A-Z]+-\d+\s+-\s+)?(.+)$/m);
    title = title || (h1 ? h1[1].trim() : path.basename(storyFile, '.md'));
    // Extract storyId from filename pattern `<ID>-<slug>.md`
    if (!storyId) {
      const m = path.basename(storyFile, '.md').match(/^([A-Z]+-?\d+)/);
      if (m) storyId = m[1];
    }
    // Extract AC block (everything between '## Acceptance Criteria' and next '##')
    const acMatch = md.match(/##\s*Acceptance Criteria\s*\n([\s\S]*?)(?=\n##\s|\n*$)/);
    if (acMatch) ac = (ac || acMatch[1].trim());
    story = md;
  }

  if (!title || !ac) {
    console.error('Missing --title and/or --ac (or pass --story <file> with those sections).');
    process.exit(1);
  }

  const cfg = loadConfig(process.cwd());
  // Hand off to the generator with consumer paths injected.
  process.env.AGENTIC_QA_CONFIG_JSON = JSON.stringify(cfg);
  const { explorePage, generateFiles, safeSlug } = require('../../ui/generator.js');

  const slug = safeSlug(title);
  const id = storyId || `CLI-${Date.now().toString(36).toUpperCase()}`;

  console.log(`[agentic-qa] story=${id} slug=${slug}`);
  console.log(`[agentic-qa] exploring ${url}…`);
  const exploration = await explorePage(url, { onProgress: (msg) => console.log(`  ${msg}`) });

  console.log('[agentic-qa] generating files via Claude API…');
  const { written, usage } = await generateFiles({
    slug, storyId: id, title, story, ac, creds, exploration,
    onProgress: (msg) => console.log(`  ${msg}`),
  });

  console.log(`\nDone. Wrote ${written.pages.length} page object(s) and ${written.tests.length} spec(s).`);
  console.log(`Tokens — input: ${usage.input_tokens}, output: ${usage.output_tokens}`);
};
