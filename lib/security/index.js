// Security scan orchestrator. Runs the requested phases against a target URL,
// aggregates + de-duplicates findings, scores overall risk, and persists a
// JSON + Markdown report under reports/security/.
//
//   runSecurityScan(targetUrl, { passive, active, probeFiles, zap, onLog })
//     → { target, startedAt, phases, findings, score, reportPath }

const fs = require('fs');
const path = require('path');
const { passiveScan, activeProbes, scoreRisk, sortFindings } = require('./scanner');
const { runZapBaseline } = require('./zap');

function dedupe(findings) {
  const seen = new Set();
  const out = [];
  for (const f of findings) {
    const key = `${f.id}|${f.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

async function runSecurityScan(targetUrl, opts = {}) {
  const onLog = opts.onLog || (() => {});
  const phases = [];
  let findings = [];

  onLog(`[security] target: ${targetUrl}`);

  if (opts.passive !== false) {
    onLog('[security] phase 1/3 — passive scan (headers, cookies, TLS, CORS)…');
    const p = await passiveScan(targetUrl, opts);
    findings.push(...p.findings);
    phases.push({ name: 'passive', reachable: p.reachable, findings: p.findings.length });
    onLog(`[security] passive scan: ${p.findings.length} finding(s)`);
    if (!p.reachable) {
      // No point probing an unreachable host.
      return finalize(targetUrl, phases, findings, opts);
    }
  }

  if (opts.active !== false) {
    onLog('[security] phase 2/3 — active probes (XSS reflection, SQLi, open redirect, methods)…');
    const a = await activeProbes(targetUrl, opts);
    findings.push(...a.findings);
    phases.push({ name: 'active', findings: a.findings.length });
    onLog(`[security] active probes: ${a.findings.length} finding(s)`);
  }

  if (opts.zap) {
    onLog('[security] phase 3/3 — OWASP ZAP baseline (Docker)…');
    const z = await runZapBaseline(targetUrl, { onLog });
    if (z.available) {
      findings.push(...z.findings);
      phases.push({ name: 'zap', findings: z.findings.length });
      onLog(`[security] ZAP baseline: ${z.findings.length} finding(s)`);
    } else {
      phases.push({ name: 'zap', skipped: true });
    }
  }

  return finalize(targetUrl, phases, findings, opts);
}

function finalize(targetUrl, phases, findings, opts) {
  findings = sortFindings(dedupe(findings));
  const score = scoreRisk(findings);
  const startedAt = opts.startedAt || null; // timestamp injected by caller (scripts can't use Date.now in workflows)
  const result = { target: targetUrl, startedAt, phases, findings, score };

  if (opts.reportsDir) {
    try {
      const dir = path.join(opts.reportsDir, 'security');
      fs.mkdirSync(dir, { recursive: true });
      const jsonPath = path.join(dir, 'latest.json');
      fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
      const mdPath = path.join(dir, 'latest.md');
      fs.writeFileSync(mdPath, renderMarkdown(result));
      result.reportPath = mdPath;
      (opts.onLog || (() => {}))(`[security] report written → ${jsonPath}`);
    } catch (err) {
      (opts.onLog || (() => {}))(`[security] could not write report: ${err.message}`);
    }
  }
  return result;
}

function renderMarkdown(result) {
  const { target, findings, score } = result;
  const lines = [];
  lines.push(`# Security Scan — ${target}`);
  lines.push('');
  lines.push(`**Risk grade: ${score.grade}** (score ${score.score}/100 — lower is better)`);
  lines.push('');
  lines.push(`| Critical | High | Medium | Low | Info |`);
  lines.push(`|---|---|---|---|---|`);
  lines.push(`| ${score.counts.critical} | ${score.counts.high} | ${score.counts.medium} | ${score.counts.low} | ${score.counts.info} |`);
  lines.push('');
  if (!findings.length) {
    lines.push('_No findings._');
  } else {
    for (const f of findings) {
      lines.push(`### [${f.severity.toUpperCase()}] ${f.title}`);
      lines.push(`- **Category:** ${f.category}`);
      lines.push(`- **URL:** ${f.url}`);
      if (f.evidence) lines.push(`- **Evidence:** ${f.evidence.replace(/\n/g, ' ')}`);
      if (f.remediation) lines.push(`- **Fix:** ${f.remediation}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

// Build a compact prompt for the Claude AI security review from scan findings.
function buildReviewPrompt(result) {
  const brief = result.findings.map((f) => `- [${f.severity}] ${f.title} (${f.category}) @ ${f.url}\n  evidence: ${f.evidence}`).join('\n');
  return [
    'You are a senior application security engineer reviewing an automated web security scan.',
    `Target: ${result.target}`,
    `Automated risk grade: ${result.score.grade} (score ${result.score.score}/100).`,
    '',
    'Raw findings from the scanner:',
    brief || '(none — the automated scan found nothing)',
    '',
    'Produce a concise security review in Markdown:',
    '1. Executive summary (2-3 sentences) an engineering manager can read.',
    '2. Prioritized remediation plan — group related findings, order by real-world exploitability, and note any that are likely false positives given the evidence.',
    '3. Gaps the automated scan cannot cover for this target (auth/session logic, business-logic authorization/IDOR, stored XSS, CSRF) and the specific manual tests you would run next.',
    'Be specific and pragmatic. Do not invent findings that are not supported by the evidence above.',
  ].join('\n');
}

module.exports = { runSecurityScan, renderMarkdown, buildReviewPrompt };
