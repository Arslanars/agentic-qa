// Diff the crawled surface against the existing suite and rank what is untested.
//
// This is the payload of the whole feature. coverage-gaps (already in the UI)
// answers "which acceptance criteria have no scenario". This answers the harder
// question the suite structurally cannot ask itself: "what does the app do that
// no AC even mentions?"
//
// Risk score is a deliberate heuristic, not a model. It has to be explainable,
// because a QA engineer will only act on a ranked list they can argue with.

const { isCovered } = require('./corpus');

// Signals, highest first. Each contributes to the score and to `why`, so every
// number on the report can be traced back to a reason.
const WEIGHTS = {
  destructive: 5,        // untested + irreversible is the worst combination
  input: 3,              // inputs carry validation rules; untested = unvalidated
  strictModeRisk: 3,     // same role+name appears more than once on the page
  routeUncovered: 3,     // the suite never navigates here at all
  consoleError: 2,       // the page is already logging errors nobody asserts on
  serverError: 4,        // a 5xx observed while merely looking at the page
  actionable: 1,         // button/tab/link — something a user can actually do
};

function scoreControl(control, routeCtx) {
  let score = 0;
  const why = [];

  if (control.destructive) { score += WEIGHTS.destructive; why.push('irreversible action'); }
  if (control.input) { score += WEIGHTS.input; why.push('user input with no validation coverage'); }
  if (control.count > 1) {
    score += WEIGHTS.strictModeRisk;
    why.push(`${control.count} elements share this role+name (Playwright strict-mode hazard)`);
  }
  if (routeCtx.routeUncovered) { score += WEIGHTS.routeUncovered; why.push('route not visited by any test'); }
  if (['button', 'tab', 'link', 'menuitem'].includes(control.role)) {
    score += WEIGHTS.actionable;
    why.push('user-actionable control');
  }
  return { score, why };
}

/**
 * @param {object} crawl  result of runCrawl()
 * @param {object} corpus result of readCorpus()
 */
function analyzeGaps(crawl, corpus) {
  const routeReports = [];
  const findings = [];

  for (const route of crawl.routes || []) {
    if (route.error) {
      routeReports.push({ route: route.route, error: route.error, untested: 0, total: 0 });
      continue;
    }

    const routeUncovered = !corpus.routes.has(route.route);
    const routeCtx = { routeUncovered };

    const untestedControls = [];
    for (const control of route.controls || []) {
      // Headings/status/alert are context, not actions — they inform a scenario
      // but are not themselves a coverage gap.
      if (['heading', 'status', 'alert', 'dialog', 'table'].includes(control.role)) continue;

      const cov = isCovered(corpus, control.role, control.name);
      if (cov.covered) continue;

      const { score, why } = scoreControl(control, routeCtx);
      untestedControls.push({
        role: control.role,
        name: control.name,
        count: control.count,
        destructive: control.destructive,
        input: control.input,
        score,
        why,
      });
    }

    untestedControls.sort((a, b) => b.score - a.score);

    // Page-level signals get their own findings — nothing in the suite asserts
    // on console errors or 5xx responses today, so an occurrence is a free bug.
    const pageSignals = [];
    if ((route.consoleErrors || []).length) {
      pageSignals.push({
        kind: 'console-errors',
        score: WEIGHTS.consoleError + (routeUncovered ? WEIGHTS.routeUncovered : 0),
        detail: `${route.consoleErrors.length} console error(s) while idle on this route`,
        samples: route.consoleErrors.slice(0, 3),
      });
    }
    const serverErrors = (route.failedRequests || []).filter((r) => /^5\d\d /.test(r));
    if (serverErrors.length) {
      pageSignals.push({
        kind: 'server-errors',
        score: WEIGHTS.serverError,
        detail: `${serverErrors.length} server error response(s) observed`,
        samples: serverErrors.slice(0, 3),
      });
    }

    routeReports.push({
      route: route.route,
      title: route.title,
      redirectedTo: route.redirectedTo || null,
      routeUncovered,
      total: (route.controls || []).length,
      untested: untestedControls.length,
      untestedControls,
      pageSignals,
      riskScore:
        untestedControls.reduce((n, c) => n + c.score, 0) +
        pageSignals.reduce((n, s) => n + s.score, 0),
    });

    for (const c of untestedControls) {
      findings.push({ route: route.route, kind: 'untested-control', ...c });
    }
    for (const s of pageSignals) {
      findings.push({ route: route.route, kind: s.kind, score: s.score, detail: s.detail, samples: s.samples });
    }
  }

  routeReports.sort((a, b) => (b.riskScore || 0) - (a.riskScore || 0));
  findings.sort((a, b) => (b.score || 0) - (a.score || 0));

  // Routes the crawler reached that the suite never navigates to at all.
  const uncoveredRoutes = routeReports.filter((r) => r.routeUncovered).map((r) => r.route);
  // Routes the suite references but the crawl never reached — either dead
  // page-object URLs or routes gated behind an action the crawler will not take.
  const crawledRoutes = new Set((crawl.routes || []).map((r) => r.route));
  const unreachedSuiteRoutes = [...corpus.routes].filter((r) => !crawledRoutes.has(r));

  return {
    routeReports,
    findings,
    findingGroups: groupFindings(findings),
    summary: {
      routesCrawled: routeReports.length,
      routesUncoveredByTests: uncoveredRoutes.length,
      uncoveredRoutes,
      unreachedSuiteRoutes,
      controlsSeen: routeReports.reduce((n, r) => n + r.total, 0),
      controlsUntested: routeReports.reduce((n, r) => n + r.untested, 0),
      destructiveUntested: findings.filter((f) => f.destructive).length,
      inputsUntested: findings.filter((f) => f.input).length,
      scenariosInSuite: corpus.scenarios.length,
    },
  };
}

/**
 * Collapse per-item repeats into one finding.
 *
 * A real crawl produced 18 separate rows for "Set pack size for CHEESE - Mozz.
 * Block", "… Cheddar Block", "… Parm. SHAVED" and so on, which buried
 * everything else. They are one gap ("per-item pack size is untested"), not 18,
 * and the same shape recurs for the ±316 stepper buttons across four routes.
 */
function findingPattern(f) {
  if (f.kind !== 'untested-control') return f.kind;
  const p = String(f.name || '')
    // "… for CHEESE - Mozz. Block" -> "… for <item>"
    .replace(/\s+for\s+.+$/i, ' for <item>')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim();
  return `${f.role} "${p}"`;
}

function groupFindings(findings) {
  const map = new Map();
  for (const f of findings) {
    const key = findingPattern(f);
    let g = map.get(key);
    if (!g) {
      g = {
        pattern: key,
        kind: f.kind,
        role: f.role || null,
        score: f.score || 0,
        instances: 0,
        elements: 0,
        routes: [],
        examples: [],
        destructive: !!f.destructive,
        input: !!f.input,
        why: f.why || (f.detail ? [f.detail] : []),
      };
      map.set(key, g);
    }
    g.instances += 1;
    g.elements += f.count || 1;
    g.score = Math.max(g.score, f.score || 0);
    g.destructive = g.destructive || !!f.destructive;
    g.input = g.input || !!f.input;
    if (!g.routes.includes(f.route)) g.routes.push(f.route);
    if (g.examples.length < 3 && f.name && !g.examples.includes(f.name)) g.examples.push(f.name);
  }
  return [...map.values()].sort((a, b) => b.score - a.score || b.elements - a.elements);
}

/** Markdown report for reports/exploration/latest.md. */
function renderMarkdown(crawl, analysis) {
  const s = analysis.summary;
  const L = [];
  L.push('# Exploratory surface report');
  L.push('');
  L.push(`- Base URL: \`${crawl.baseUrl}\``);
  L.push(`- Crawl mode: \`${crawl.mode}\`${crawl.mode === 'passive' ? ' (navigation only — zero clicks)' : ' (navigation + allowlisted nav clicks)'}`);
  L.push(`- Routes crawled: **${s.routesCrawled}**${crawl.stats && crawl.stats.cappedAtRoutes ? ' _(hit the route cap — more surface remains)_' : ''}`);
  L.push(`- Controls seen: **${s.controlsSeen}**, of which **${s.controlsUntested}** are not referenced anywhere in the suite`);
  L.push(`- Routes no test navigates to: **${s.routesUncoveredByTests}**${s.uncoveredRoutes.length ? ` (${s.uncoveredRoutes.join(', ')})` : ''}`);
  if (s.unreachedSuiteRoutes.length) {
    L.push(`- Routes the suite references but the crawl never reached: ${s.unreachedSuiteRoutes.map((r) => `\`${r}\``).join(', ')}`);
  }
  L.push(`- Existing scenarios: ${s.scenariosInSuite}`);
  L.push('');

  L.push('## Highest-risk untested surface');
  L.push('');
  L.push('_Per-item repeats are grouped: "instances" counts distinct control names, "elements" counts matching elements on the page._');
  L.push('');
  const groups = (analysis.findingGroups || []).slice(0, 20);
  if (!groups.length) {
    L.push('_Nothing untested was found. Either coverage is genuinely complete or the crawl saw too little._');
  } else {
    L.push('| Score | Control | Instances | Elements | Routes | Why |');
    L.push('|---:|---|---:|---:|---|---|');
    for (const g of groups) {
      const flags = [g.destructive ? '**destructive**' : null, g.input ? '_input_' : null]
        .filter(Boolean).join(' ');
      L.push(
        `| ${g.score} | ${g.pattern}${flags ? ' ' + flags : ''} | ${g.instances} | ${g.elements} | ` +
        `${g.routes.map((r) => `\`${r}\``).join(', ')} | ${(g.why || []).join('; ')} |`
      );
    }
    const shown = groups.reduce((n, g) => n + g.instances, 0);
    const total = (analysis.findings || []).length;
    if (total > shown) L.push('');
    if (total > shown) L.push(`_${total - shown} further finding(s) not shown; see latest.json._`);
  }
  L.push('');

  L.push('## Per-route detail');
  for (const r of analysis.routeReports) {
    L.push('');
    L.push(`### \`${r.route}\`${r.title ? ` — ${r.title}` : ''}  (risk ${r.riskScore || 0})`);
    if (r.error) { L.push(`- **crawl error:** ${r.error}`); continue; }
    if (r.redirectedTo) L.push(`- redirected to \`${r.redirectedTo}\` — not independently reachable`);
    if (r.routeUncovered) L.push('- **no test navigates to this route**');
    L.push(`- ${r.untested} untested of ${r.total} controls`);
    for (const sig of r.pageSignals || []) {
      L.push(`- **${sig.kind}**: ${sig.detail}`);
      for (const sample of sig.samples || []) L.push(`  - \`${String(sample).slice(0, 160)}\``);
    }
    for (const c of (r.untestedControls || []).slice(0, 12)) {
      L.push(`- [${c.score}] \`${c.role}\` "${c.name}"${c.count > 1 ? ` ×${c.count}` : ''}${c.destructive ? ' **(destructive)**' : ''}${c.input ? ' _(input)_' : ''}`);
    }
    if ((r.untestedControls || []).length > 12) {
      L.push(`- _… +${r.untestedControls.length - 12} more_`);
    }
  }

  if ((crawl.skipped || []).length) {
    L.push('');
    L.push('## Deliberately not touched');
    L.push('');
    L.push('The crawler refuses these; each is a candidate scenario to write **by hand**.');
    L.push('');
    const byReason = new Map();
    for (const sk of crawl.skipped) {
      const k = sk.reason;
      if (!byReason.has(k)) byReason.set(k, []);
      byReason.get(k).push(sk.control || sk.route);
    }
    for (const [reason, items] of byReason) {
      L.push(`- **${reason}** (${items.length}): ${[...new Set(items)].slice(0, 12).join(', ')}`);
    }
  }

  return L.join('\n') + '\n';
}

module.exports = { analyzeGaps, renderMarkdown, groupFindings, findingPattern, WEIGHTS };
