// Dependency-free web security scanner. Two phases:
//
//   passiveScan(url)  — send a couple of benign requests and grade the
//                       response: security headers, cookie flags, TLS,
//                       tech-stack disclosure, CORS misconfig. Never mutates
//                       target state; safe to run against production.
//
//   activeProbes(url) — safe, read-only probes for the most common web
//                       vulnerability classes: reflected-XSS reflection,
//                       SQLi error signatures, open redirects, risky HTTP
//                       methods, and (opt-in) exposed sensitive files.
//                       GET-only by default; still only run against systems
//                       you are authorized to test.
//
// Every check returns findings shaped like:
//   { id, title, severity, category, evidence, remediation, url }
// severity ∈ critical | high | medium | low | info
// category is an OWASP Top-10 (2021) bucket for grouping in the report.

const https = require('https');
const { URL } = require('url');

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

// A short, realistic UA so WAFs/CDNs don't reject the probe outright.
const UA = 'agentic-qa-security-scanner/1.0 (+authorized-testing)';

// ---------------------------------------------------------------------------
// low-level fetch with timeout + no-throw semantics
// ---------------------------------------------------------------------------
async function safeFetch(url, opts = {}) {
  const controller = new AbortController();
  const timeout = opts.timeoutMs || 15000;
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      redirect: opts.redirect || 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': UA, ...(opts.headers || {}) },
      method: opts.method || 'GET',
    });
    let body = '';
    // Only read a bounded slice of the body — enough to detect reflection /
    // error signatures without pulling multi-MB pages into memory.
    if (opts.readBody !== false) {
      const text = await res.text();
      body = text.slice(0, 200_000);
    }
    return { ok: true, status: res.status, headers: res.headers, body, url: res.url || url };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), url };
  } finally {
    clearTimeout(timer);
  }
}

function finding(f) {
  return {
    id: f.id,
    title: f.title,
    severity: f.severity || 'info',
    category: f.category || 'A05:2021 Security Misconfiguration',
    evidence: f.evidence || '',
    remediation: f.remediation || '',
    url: f.url || '',
  };
}

// ---------------------------------------------------------------------------
// TLS certificate inspection (expiry / self-signed). Best-effort.
// ---------------------------------------------------------------------------
function inspectTls(targetUrl) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(targetUrl); } catch { return resolve(null); }
    if (u.protocol !== 'https:') return resolve(null);
    const req = https.request(
      { host: u.hostname, port: u.port || 443, method: 'HEAD', path: '/', timeout: 10000, rejectUnauthorized: false },
      (res) => {
        const cert = res.socket.getPeerCertificate?.();
        const authorized = res.socket.authorized;
        resolve({ cert: cert && cert.valid_to ? cert : null, authorized });
        res.destroy();
      }
    );
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// PASSIVE SCAN
// ---------------------------------------------------------------------------
async function passiveScan(targetUrl, opts = {}) {
  const findings = [];
  const res = await safeFetch(targetUrl, { redirect: 'follow', timeoutMs: opts.timeoutMs });
  if (!res.ok) {
    findings.push(finding({
      id: 'target-unreachable', title: 'Target could not be reached', severity: 'info',
      category: 'A05:2021 Security Misconfiguration',
      evidence: res.error, remediation: 'Confirm the URL is correct and the host is reachable from this machine.',
      url: targetUrl,
    }));
    return { findings, reachable: false };
  }

  const h = res.headers;
  const finalUrl = res.url;
  const isHttps = finalUrl.startsWith('https:');
  const get = (name) => h.get(name);

  // --- Security headers -----------------------------------------------------
  if (!get('content-security-policy')) {
    findings.push(finding({
      id: 'missing-csp', title: 'Missing Content-Security-Policy header', severity: 'medium',
      category: 'A05:2021 Security Misconfiguration',
      evidence: 'No Content-Security-Policy response header present.',
      remediation: "Add a restrictive CSP, e.g. default-src 'self'; object-src 'none'; frame-ancestors 'none'.",
      url: finalUrl,
    }));
  }
  if (isHttps && !get('strict-transport-security')) {
    findings.push(finding({
      id: 'missing-hsts', title: 'Missing Strict-Transport-Security (HSTS)', severity: 'medium',
      category: 'A02:2021 Cryptographic Failures',
      evidence: 'HTTPS response has no Strict-Transport-Security header.',
      remediation: 'Add: Strict-Transport-Security: max-age=31536000; includeSubDomains; preload',
      url: finalUrl,
    }));
  }
  const xfo = get('x-frame-options');
  const csp = get('content-security-policy') || '';
  if (!xfo && !/frame-ancestors/i.test(csp)) {
    findings.push(finding({
      id: 'clickjacking', title: 'No clickjacking protection (X-Frame-Options / frame-ancestors)', severity: 'medium',
      category: 'A05:2021 Security Misconfiguration',
      evidence: 'Neither X-Frame-Options nor a CSP frame-ancestors directive is set.',
      remediation: "Add X-Frame-Options: DENY or CSP frame-ancestors 'none'.",
      url: finalUrl,
    }));
  }
  if ((get('x-content-type-options') || '').toLowerCase() !== 'nosniff') {
    findings.push(finding({
      id: 'missing-nosniff', title: 'Missing X-Content-Type-Options: nosniff', severity: 'low',
      category: 'A05:2021 Security Misconfiguration',
      evidence: `X-Content-Type-Options is "${get('x-content-type-options') || '(absent)'}".`,
      remediation: 'Add X-Content-Type-Options: nosniff to prevent MIME sniffing.',
      url: finalUrl,
    }));
  }
  if (!get('referrer-policy')) {
    findings.push(finding({
      id: 'missing-referrer-policy', title: 'Missing Referrer-Policy header', severity: 'low',
      category: 'A05:2021 Security Misconfiguration',
      evidence: 'No Referrer-Policy header — full URLs may leak to third parties.',
      remediation: 'Add Referrer-Policy: strict-origin-when-cross-origin (or stricter).',
      url: finalUrl,
    }));
  }
  if (!get('permissions-policy')) {
    findings.push(finding({
      id: 'missing-permissions-policy', title: 'Missing Permissions-Policy header', severity: 'info',
      category: 'A05:2021 Security Misconfiguration',
      evidence: 'No Permissions-Policy header restricting powerful browser features.',
      remediation: 'Add a Permissions-Policy disabling unused features, e.g. geolocation=(), camera=(), microphone=().',
      url: finalUrl,
    }));
  }

  // --- Transport ------------------------------------------------------------
  if (!isHttps) {
    findings.push(finding({
      id: 'no-https', title: 'Site served over plain HTTP', severity: 'high',
      category: 'A02:2021 Cryptographic Failures',
      evidence: `Final URL after redirects is ${finalUrl}`,
      remediation: 'Serve all traffic over HTTPS and redirect HTTP → HTTPS.',
      url: finalUrl,
    }));
  }

  // --- Cookie flags ---------------------------------------------------------
  // Node fetch collapses multiple Set-Cookie into getSetCookie() (Node 18.13+).
  const cookies = typeof h.getSetCookie === 'function' ? h.getSetCookie() : (get('set-cookie') ? [get('set-cookie')] : []);
  for (const c of cookies) {
    const name = (c.split('=')[0] || 'cookie').trim();
    const lc = c.toLowerCase();
    const missing = [];
    if (!/;\s*httponly/.test(lc)) missing.push('HttpOnly');
    if (isHttps && !/;\s*secure/.test(lc)) missing.push('Secure');
    if (!/;\s*samesite/.test(lc)) missing.push('SameSite');
    if (missing.length) {
      findings.push(finding({
        id: `cookie-flags-${name}`, title: `Cookie "${name}" missing ${missing.join(', ')} flag(s)`, severity: 'medium',
        category: 'A05:2021 Security Misconfiguration',
        evidence: c.slice(0, 200),
        remediation: `Set the ${missing.join(', ')} attribute(s) on the ${name} cookie.`,
        url: finalUrl,
      }));
    }
  }

  // --- Tech-stack / version disclosure --------------------------------------
  for (const [hdr, label] of [['server', 'Server'], ['x-powered-by', 'X-Powered-By'], ['x-aspnet-version', 'X-AspNet-Version'], ['x-aspnetmvc-version', 'X-AspNetMvc-Version']]) {
    const v = get(hdr);
    if (v && /\d/.test(v)) {
      findings.push(finding({
        id: `disclosure-${hdr}`, title: `Version disclosure via ${label} header`, severity: 'low',
        category: 'A05:2021 Security Misconfiguration',
        evidence: `${label}: ${v}`,
        remediation: `Remove or genericize the ${label} header so exact software versions aren't advertised.`,
        url: finalUrl,
      }));
    }
  }

  // --- CORS misconfiguration ------------------------------------------------
  const acao = get('access-control-allow-origin');
  const acac = (get('access-control-allow-credentials') || '').toLowerCase();
  if (acao === '*' && acac === 'true') {
    findings.push(finding({
      id: 'cors-wildcard-creds', title: 'CORS allows any origin with credentials', severity: 'high',
      category: 'A05:2021 Security Misconfiguration',
      evidence: 'Access-Control-Allow-Origin: * together with Access-Control-Allow-Credentials: true.',
      remediation: 'Never combine a wildcard origin with credentials. Echo only an explicit allow-list of origins.',
      url: finalUrl,
    }));
  }

  // --- TLS cert -------------------------------------------------------------
  if (isHttps) {
    const tls = await inspectTls(finalUrl);
    if (tls && tls.authorized === false) {
      findings.push(finding({
        id: 'tls-untrusted', title: 'TLS certificate is not trusted / self-signed', severity: 'high',
        category: 'A02:2021 Cryptographic Failures',
        evidence: 'The presented certificate failed default trust validation.',
        remediation: 'Install a certificate issued by a trusted CA (e.g. Let’s Encrypt).',
        url: finalUrl,
      }));
    }
    if (tls && tls.cert && tls.cert.valid_to) {
      const daysLeft = Math.round((new Date(tls.cert.valid_to).getTime() - Date.now()) / 86_400_000);
      if (daysLeft < 0) {
        findings.push(finding({
          id: 'tls-expired', title: 'TLS certificate has expired', severity: 'critical',
          category: 'A02:2021 Cryptographic Failures',
          evidence: `Certificate valid_to = ${tls.cert.valid_to}`,
          remediation: 'Renew the TLS certificate immediately.', url: finalUrl,
        }));
      } else if (daysLeft < 14) {
        findings.push(finding({
          id: 'tls-expiring', title: `TLS certificate expires in ${daysLeft} day(s)`, severity: 'medium',
          category: 'A02:2021 Cryptographic Failures',
          evidence: `Certificate valid_to = ${tls.cert.valid_to}`,
          remediation: 'Renew the certificate and automate renewal.', url: finalUrl,
        }));
      }
    }
  }

  return { findings, reachable: true, finalUrl, status: res.status };
}

// ---------------------------------------------------------------------------
// ACTIVE PROBES (read-only, GET-based)
// ---------------------------------------------------------------------------
const XSS_CANARY = 'qa7x1ss"\'><svg';
const SQL_ERROR_SIGNATURES = [
  'you have an error in your sql syntax',
  'warning: mysql',
  'unclosed quotation mark after the character string',
  'quoted string not properly terminated',
  'pg_query()', 'psql: error', 'sqlite3::', 'sqlstate[',
  'ora-01756', 'ora-00933', 'odbc sql server driver',
];
const REDIRECT_PARAMS = ['next', 'url', 'redirect', 'redirect_uri', 'return', 'returnUrl', 'dest', 'destination', 'continue', 'r'];
const CANARY_HOST = 'example-canary.test';

function withParam(targetUrl, key, value) {
  const u = new URL(targetUrl);
  u.searchParams.set(key, value);
  return u.toString();
}

async function activeProbes(targetUrl, opts = {}) {
  const findings = [];
  let base;
  try { base = new URL(targetUrl); } catch {
    return { findings, note: 'invalid URL' };
  }

  // --- Reflected input reflection (potential XSS) ---------------------------
  try {
    const probeUrl = withParam(targetUrl, 'qa_probe', XSS_CANARY);
    const r = await safeFetch(probeUrl, { redirect: 'follow', timeoutMs: opts.timeoutMs });
    if (r.ok && r.body && r.body.includes(XSS_CANARY)) {
      // Reflected verbatim including < > " ' — encoding is clearly absent.
      findings.push(finding({
        id: 'reflected-xss', title: 'User input reflected without output encoding (possible XSS)', severity: 'high',
        category: 'A03:2021 Injection',
        evidence: `The value "${XSS_CANARY}" sent as ?qa_probe= was reflected verbatim (incl. < > " ') in the HTML response.`,
        remediation: 'Context-aware output-encode all user input; add a strict CSP as defence in depth. Confirm with a manual XSS payload.',
        url: probeUrl,
      }));
    }
  } catch (_) { /* ignore probe errors */ }

  // --- SQL injection error signatures ---------------------------------------
  // Only meaningful if the URL already carries query params to tamper with.
  if (base.search) {
    try {
      const u = new URL(targetUrl);
      const firstKey = [...u.searchParams.keys()][0];
      if (firstKey) {
        u.searchParams.set(firstKey, u.searchParams.get(firstKey) + "'");
        const r = await safeFetch(u.toString(), { redirect: 'follow', timeoutMs: opts.timeoutMs });
        const bodyLc = (r.body || '').toLowerCase();
        const hit = SQL_ERROR_SIGNATURES.find((s) => bodyLc.includes(s));
        if (r.ok && hit) {
          findings.push(finding({
            id: 'sqli-error', title: 'SQL error surfaced when tampering with a query parameter', severity: 'critical',
            category: 'A03:2021 Injection',
            evidence: `Appending a single quote to "${firstKey}" produced a database error containing: "${hit}".`,
            remediation: 'Use parameterized queries / prepared statements. Never build SQL from raw input. Suppress DB errors in responses.',
            url: u.toString(),
          }));
        }
      }
    } catch (_) { /* ignore */ }
  }

  // --- Open redirect --------------------------------------------------------
  for (const param of REDIRECT_PARAMS) {
    try {
      const probeUrl = withParam(targetUrl, param, `https://${CANARY_HOST}/`);
      const r = await safeFetch(probeUrl, { redirect: 'manual', readBody: false, timeoutMs: opts.timeoutMs });
      const loc = r.ok ? r.headers.get('location') : null;
      if (loc && new RegExp(`^https?://${CANARY_HOST.replace('.', '\\.')}`, 'i').test(loc)) {
        findings.push(finding({
          id: `open-redirect-${param}`, title: `Open redirect via "${param}" parameter`, severity: 'medium',
          category: 'A01:2021 Broken Access Control',
          evidence: `?${param}=https://${CANARY_HOST}/ produced a redirect to ${loc}`,
          remediation: 'Validate redirect targets against an allow-list of internal paths; never redirect to an attacker-supplied absolute URL.',
          url: probeUrl,
        }));
        break; // one confirmed open redirect is enough to report
      }
    } catch (_) { /* ignore */ }
  }

  // --- Risky HTTP methods ---------------------------------------------------
  try {
    const r = await safeFetch(targetUrl, { method: 'OPTIONS', readBody: false, timeoutMs: opts.timeoutMs });
    const allow = r.ok ? (r.headers.get('allow') || r.headers.get('access-control-allow-methods') || '') : '';
    const risky = ['TRACE', 'TRACK', 'PUT', 'DELETE', 'CONNECT'].filter((m) => new RegExp(`\\b${m}\\b`, 'i').test(allow));
    if (risky.length) {
      findings.push(finding({
        id: 'risky-methods', title: `Potentially dangerous HTTP methods advertised: ${risky.join(', ')}`, severity: 'low',
        category: 'A05:2021 Security Misconfiguration',
        evidence: `OPTIONS response Allow: ${allow}`,
        remediation: 'Disable TRACE/TRACK; restrict write methods (PUT/DELETE) to authenticated, authorized API routes only.',
        url: targetUrl,
      }));
    }
  } catch (_) { /* ignore */ }

  // --- Exposed sensitive files (opt-in; more intrusive) ---------------------
  if (opts.probeFiles) {
    const origin = `${base.protocol}//${base.host}`;
    const sensitive = [
      { path: '/.env', sig: /(^|\n)[A-Z0-9_]+=/ },
      { path: '/.git/config', sig: /\[core\]|\[remote/ },
      { path: '/server-status', sig: /Apache Server Status/i },
      { path: '/.aws/credentials', sig: /aws_access_key_id/i },
      { path: '/config.json', sig: /"(password|secret|apiKey|token)"/i },
    ];
    for (const s of sensitive) {
      try {
        const r = await safeFetch(origin + s.path, { redirect: 'manual', timeoutMs: opts.timeoutMs });
        if (r.ok && r.status === 200 && s.sig.test(r.body || '')) {
          findings.push(finding({
            id: `exposed-file${s.path.replace(/[^a-z0-9]+/gi, '-')}`, title: `Sensitive file exposed: ${s.path}`, severity: 'critical',
            category: 'A05:2021 Security Misconfiguration',
            evidence: `GET ${s.path} returned 200 with content matching a sensitive-file signature.`,
            remediation: `Block public access to ${s.path}; move secrets out of the web root and rotate any exposed credentials.`,
            url: origin + s.path,
          }));
        }
      } catch (_) { /* ignore */ }
    }
  }

  return { findings };
}

// ---------------------------------------------------------------------------
// Risk scoring — weighted count, 0..100 (higher = worse).
// ---------------------------------------------------------------------------
const WEIGHTS = { critical: 40, high: 15, medium: 5, low: 2, info: 0 };
function scoreRisk(findings) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  let raw = 0;
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] || 0) + 1;
    raw += WEIGHTS[f.severity] || 0;
  }
  const score = Math.min(100, raw);
  let grade = 'A';
  if (counts.critical > 0 || score >= 60) grade = 'F';
  else if (score >= 40) grade = 'D';
  else if (score >= 20) grade = 'C';
  else if (score >= 8) grade = 'B';
  return { score, grade, counts };
}

function sortFindings(findings) {
  return [...findings].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
}

module.exports = { passiveScan, activeProbes, scoreRisk, sortFindings, safeFetch };
