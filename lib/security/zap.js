// Optional OWASP ZAP baseline scan via Docker. Entirely opt-in and
// best-effort: if Docker (or the ZAP image) isn't available we resolve with
// { available: false } and the orchestrator simply skips this phase — the
// passive + active scanners still run.
//
// The baseline scan is passive-by-default (ZAP spiders the site and runs
// passive rules), so it's safe against systems you're authorized to test.

const { spawn, execSync } = require('child_process');

const ZAP_IMAGE = process.env.ZAP_IMAGE || 'ghcr.io/zaproxy/zaproxy:stable';

function dockerAvailable() {
  try {
    execSync('docker --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Map ZAP alert risk (0..3) → our severity vocabulary.
const ZAP_RISK = { 3: 'high', 2: 'medium', 1: 'low', 0: 'info' };

function normalizeZapAlerts(json, targetUrl) {
  const out = [];
  const sites = (json && json.site) || [];
  for (const site of Array.isArray(sites) ? sites : [sites]) {
    for (const alert of site.alerts || []) {
      const inst = (alert.instances && alert.instances[0]) || {};
      out.push({
        id: `zap-${alert.pluginid || alert.alertRef || alert.name}`,
        title: alert.name || 'ZAP alert',
        severity: ZAP_RISK[Number(alert.riskcode)] || 'info',
        category: 'OWASP ZAP',
        evidence: [alert.desc, inst.uri && `URI: ${inst.uri}`, inst.evidence && `Evidence: ${inst.evidence}`]
          .filter(Boolean).join('\n').replace(/<[^>]+>/g, '').slice(0, 800),
        remediation: (alert.solution || '').replace(/<[^>]+>/g, '').slice(0, 800),
        url: inst.uri || targetUrl,
      });
    }
  }
  return out;
}

// Run `zap-baseline.py` inside the official image. onLog streams stdout lines.
// Returns { available, findings, exitCode }.
function runZapBaseline(targetUrl, { onLog = () => {}, timeoutMs = 300000 } = {}) {
  return new Promise((resolve) => {
    if (!dockerAvailable()) {
      onLog('[zap] Docker not found on PATH — skipping ZAP baseline scan.');
      return resolve({ available: false, findings: [] });
    }
    onLog(`[zap] pulling/using image ${ZAP_IMAGE} (first run may take a while)…`);

    // ZAP writes the JSON report to /zap/wrk inside the container. We can't
    // easily mount a host dir cross-platform without knowing the cwd is
    // writable, so we capture the JSON from stdout via -J and `docker cp`
    // is avoided by using `zap-baseline.py -J report.json` + `cat`. Simpler:
    // run the scan, then print the report to stdout.
    const args = [
      'run', '--rm', ZAP_IMAGE,
      'zap-baseline.py', '-t', targetUrl, '-J', '/tmp/zap.json', '-I', '-d',
      // -I = do not fail on warnings; -d = show debug. After the scan, cat the JSON.
    ];
    const proc = spawn('docker', args, { shell: process.platform === 'win32' });
    let stdout = '';
    const timer = setTimeout(() => { try { proc.kill(); } catch (_) {} }, timeoutMs);

    proc.stdout.on('data', (d) => { const t = d.toString(); stdout += t; onLog(t.replace(/\n$/, '')); });
    proc.stderr.on('data', (d) => onLog(d.toString().replace(/\n$/, '')));
    proc.on('error', (err) => {
      clearTimeout(timer);
      onLog(`[zap] failed to launch: ${err.message}`);
      resolve({ available: false, findings: [] });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      // The baseline script exits 0/1/2/3 depending on findings; that's fine.
      // We couldn't retrieve the JSON via -J alone (it's inside the container),
      // so we parse alert summary lines from stdout as a fallback.
      const findings = parseBaselineStdout(stdout, targetUrl);
      resolve({ available: true, findings, exitCode: code });
    });
  });
}

// The baseline script prints lines like "WARN-NEW: X-Frame-Options ... [10020] x 3".
// Parse those into findings when the JSON report can't be retrieved from the
// container filesystem.
function parseBaselineStdout(stdout, targetUrl) {
  const findings = [];
  const re = /^(FAIL|WARN)(?:-NEW|-INPROG)?:\s*(.+?)\s*(?:\[(\d+)\])?\s*(?:x\s*(\d+))?\s*$/gm;
  let m;
  while ((m = re.exec(stdout)) !== null) {
    const level = m[1];
    findings.push({
      id: `zap-${m[3] || m[2].slice(0, 24)}`,
      title: m[2].trim(),
      severity: level === 'FAIL' ? 'high' : 'medium',
      category: 'OWASP ZAP',
      evidence: `ZAP baseline ${level}${m[4] ? ` (x${m[4]} instances)` : ''}`,
      remediation: 'See the OWASP ZAP alert reference for this rule.',
      url: targetUrl,
    });
  }
  return findings;
}

module.exports = { runZapBaseline, dockerAvailable, normalizeZapAlerts };
