// Exploratory testing engine — orchestrator.
//
//   crawl the live app (read-only)  ->  read what the suite covers
//     ->  diff + rank untested surface  ->  write reports/exploration/
//
// Mirrors the shape of lib/security/index.js (runScan -> finalize -> render +
// buildPrompt) so it drops into the existing UI/CLI patterns: reports land
// under reports/exploration/latest.{json,md} exactly like security and perf,
// and buildScenarioPrompt() is the handoff to the claude CLI for drafting
// Gherkin, matching lib/security's buildReviewPrompt().

const fs = require('fs');
const path = require('path');

const { runCrawl } = require('./crawler');
const { readCorpus } = require('./corpus');
const { analyzeGaps, renderMarkdown } = require('./gaps');

async function runExploration(opts = {}) {
  const onLog = opts.onLog || (() => {});
  const root = opts.root || process.cwd();

  if (!opts.baseUrl) throw new Error('runExploration: baseUrl is required');
  if (!opts.email || !opts.password) {
    throw new Error('runExploration: email and password are required (the crawl must authenticate)');
  }

  onLog(`[explore] mode=${opts.mode || 'passive'} base=${opts.baseUrl}`);
  const crawl = await runCrawl({
    baseUrl: opts.baseUrl,
    email: opts.email,
    password: opts.password,
    mode: opts.mode || 'passive',
    seeds: opts.seeds || [],
    unlock: opts.unlock,
    maxRoutes: opts.maxRoutes,
    maxDurationMs: opts.maxDurationMs,
    headless: opts.headless !== false,
    onLog,
  });

  if (!crawl.ok) {
    onLog(`[explore] crawl aborted: ${crawl.error}`);
    return { ok: false, crawl, error: crawl.error };
  }

  onLog(`[explore] reading suite corpus…`);
  const corpus = readCorpus({ root });
  onLog(
    `[explore] corpus: ${corpus.files.pages} page object(s), ${corpus.files.steps} step file(s), ` +
    `${corpus.files.features} feature(s), ${corpus.scenarios.length} scenario(s), ` +
    `${corpus.allNames.size} distinct targeted name(s)`
  );

  const analysis = analyzeGaps(crawl, corpus);
  onLog(
    `[explore] ${analysis.summary.controlsUntested}/${analysis.summary.controlsSeen} controls untested ` +
    `across ${analysis.summary.routesCrawled} route(s)`
  );

  const written = [];
  const reportsDir = opts.reportsDir || path.join(root, 'reports');
  try {
    const dir = path.join(reportsDir, 'exploration');
    fs.mkdirSync(dir, { recursive: true });
    const jsonPath = path.join(dir, 'latest.json');
    const mdPath = path.join(dir, 'latest.md');
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({ startedAt: opts.startedAt || null, crawl, analysis }, null, 2),
      'utf8'
    );
    fs.writeFileSync(mdPath, renderMarkdown(crawl, analysis), 'utf8');
    written.push(jsonPath, mdPath);
    // Also drop the drafting prompt on disk. POST /api/explore/draft pipes the
    // same text to the claude CLI, but writing it makes the feature usable in
    // CI or by hand with no claude dependency at all.
    const promptPath = path.join(dir, 'draft-prompt.md');
    fs.writeFileSync(promptPath, buildScenarioPrompt(crawl, analysis) + '\n', 'utf8');
    written.push(promptPath);
    onLog(`[explore] wrote ${path.relative(root, jsonPath)}, ${path.relative(root, mdPath)} and ${path.relative(root, promptPath)}`);
  } catch (err) {
    onLog(`[explore] could not write reports: ${err.message}`);
  }

  return { ok: true, crawl, corpus: summarizeCorpus(corpus), analysis, written };
}

function summarizeCorpus(corpus) {
  return {
    files: corpus.files,
    scenarios: corpus.scenarios.length,
    routes: [...corpus.routes],
    namesTargeted: corpus.allNames.size,
  };
}

/**
 * Prompt for the claude CLI to draft Gherkin for the top gaps.
 *
 * Deliberately constrained: draft scenarios into specs/ for review rather than
 * writing .feature files directly, and never draft a scenario that performs a
 * destructive action — those get flagged for a human to write with the
 * @destructive tag, matching the convention already in features/.
 */
function buildScenarioPrompt(crawl, analysis, opts = {}) {
  const limit = opts.limit || 10;
  // Draft from GROUPS, not raw findings. The raw list holds 18 separate
  // "Set pack size for <item>" entries; drafting from those yields 18
  // near-identical scenarios instead of one parameterised scenario.
  const groups = analysis.findingGroups || [];
  const top = groups
    .filter((g) => g.kind === 'untested-control' && !g.destructive)
    .slice(0, limit);
  const destructive = groups.filter((g) => g.destructive).slice(0, 10);

  const lines = [];
  lines.push('You are a senior QA engineer working in an existing playwright-bdd repo.');
  lines.push('');
  lines.push(`An exploratory crawl of ${crawl.baseUrl} found app surface that NO existing scenario covers.`);
  lines.push('Your job: draft Gherkin scenarios for the gaps listed below.');
  lines.push('');
  lines.push('HARD RULES:');
  lines.push('- Write drafts into specs/exploratory-<slug>.md. Do NOT create or edit .feature files.');
  lines.push('- Reuse existing step phrasing wherever possible. Read features/**/*.steps.ts first and');
  lines.push('  prefer an existing Given/When/Then over inventing a new one.');
  lines.push('- Reuse existing page objects in pages/. Do not duplicate selectors.');
  lines.push('- Locate by role + accessible name, matching the convention in pages/*.ts.');
  lines.push('- Do NOT draft any scenario that sends, saves, deletes, creates or otherwise mutates data.');
  lines.push('- Every scenario must be independently runnable and must assert something observable.');
  lines.push('');
  lines.push('UNTESTED SURFACE (highest risk first):');
  for (const g of top) {
    const where = g.routes.map((r) => `\`${r}\``).join(', ');
    const eg = g.examples.length > 1 ? `  e.g. ${g.examples.slice(0, 3).map((e) => `"${e}"`).join(', ')}` : '';
    lines.push(
      `- ${g.pattern} on ${where} — ${g.instances} distinct name(s), ${g.elements} element(s). ` +
      `${(g.why || []).join('; ')}.${eg}`
    );
    if (g.instances > 1) {
      lines.push('    ^ these are per-item repeats: write ONE Scenario Outline with an Examples table, not one scenario each.');
    }
  }
  if (destructive.length) {
    lines.push('');
    lines.push('DO NOT AUTOMATE THESE — list them at the end of your draft under "Needs a human + @destructive":');
    for (const g of destructive) {
      lines.push(`- ${g.pattern} on ${g.routes.map((r) => `\`${r}\``).join(', ')} (${g.elements} element(s))`);
    }
  }
  const gatedRoutes = analysis.summary.uncoveredRoutes || [];
  if (gatedRoutes.length) {
    lines.push('');
    lines.push(`Routes no test currently navigates to: ${gatedRoutes.join(', ')}`);
  }
  return lines.join('\n');
}

module.exports = { runExploration, buildScenarioPrompt, summarizeCorpus };
