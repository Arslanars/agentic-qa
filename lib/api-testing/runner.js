// Dependency-free request-level API test runner (no browser). Suites are
// plain JSON files under <root>/api-tests/*.json:
//
// {
//   "name": "Auth API",
//   "baseUrl": "https://api.example.com",
//   "variables": { "email": "qa@example.com" },
//   "requests": [
//     {
//       "name": "login",
//       "method": "POST",
//       "path": "/login",
//       "headers": { "Content-Type": "application/json" },
//       "body": { "email": "{{email}}", "password": "{{PASSWORD}}" },
//       "expect": {
//         "status": 200,
//         "maxLatencyMs": 800,
//         "bodyContains": "token",
//         "headers": { "content-type": "application/json" },
//         "json": { "$.token": "exists", "$.user.role": "admin", "$.items": "array" }
//       },
//       "capture": { "TOKEN": "$.token" }
//     }
//   ]
// }
//
// {{VAR}} placeholders resolve against variables, captured values, and
// process.env (so secrets can come from the environment, not the file).

const fs = require('fs');
const path = require('path');

function listSuites(rootDir) {
  const dir = path.join(rootDir, 'api-tests');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => {
      try {
        const json = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        return { file: f, name: json.name || f, requests: (json.requests || []).length };
      } catch {
        return { file: f, name: f, error: 'invalid JSON' };
      }
    });
}

function loadSuite(rootDir, file) {
  const p = path.join(rootDir, 'api-tests', file);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Resolve {{VAR}} placeholders in strings / nested objects.
function interpolate(value, scope) {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
      if (k in scope) return String(scope[k]);
      if (process.env[k] != null) return String(process.env[k]);
      return '';
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, scope));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, scope);
    return out;
  }
  return value;
}

// Minimal dot-path getter supporting $.a.b and $.a[0].b
function getPath(obj, jsonPath) {
  const clean = jsonPath.replace(/^\$\.?/, '');
  if (!clean) return obj;
  const parts = clean.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function checkJsonExpectation(actual, expected) {
  // expected can be: "exists" | "array" | "number" | "string" | "boolean" | "object" | a literal value
  if (expected === 'exists') return actual !== undefined;
  if (expected === 'array') return Array.isArray(actual);
  if (['number', 'string', 'boolean', 'object'].includes(expected)) {
    if (expected === 'object') return actual && typeof actual === 'object' && !Array.isArray(actual);
    return typeof actual === expected;
  }
  return actual === expected;
}

async function runRequest(req, ctx) {
  const scope = { ...ctx.variables, ...ctx.captured };
  const baseUrl = ctx.baseUrl || '';
  const url = interpolate((baseUrl + (req.path || '')), scope) || interpolate(req.url || '', scope);
  const method = (req.method || 'GET').toUpperCase();
  const headers = interpolate(req.headers || {}, scope);
  let body;
  if (req.body != null) {
    const b = interpolate(req.body, scope);
    body = typeof b === 'string' ? b : JSON.stringify(b);
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type') && typeof b !== 'string') {
      headers['Content-Type'] = 'application/json';
    }
  }

  const started = ctx.now();
  let status = 0, respHeaders = null, text = '', json = null, error = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs || 20000);
    const res = await fetch(url, { method, headers, body, redirect: 'follow', signal: controller.signal });
    clearTimeout(timer);
    status = res.status;
    respHeaders = res.headers;
    text = await res.text();
    try { json = JSON.parse(text); } catch { /* not json */ }
  } catch (err) {
    error = String((err && err.message) || err);
  }
  const latencyMs = ctx.now() - started;

  // --- Assertions -----------------------------------------------------------
  const checks = [];
  const exp = req.expect || {};
  if (error) {
    checks.push({ ok: false, label: 'request completed', detail: error });
  } else {
    if (exp.status != null) checks.push({ ok: status === exp.status, label: `status == ${exp.status}`, detail: `got ${status}` });
    if (exp.maxLatencyMs != null) checks.push({ ok: latencyMs <= exp.maxLatencyMs, label: `latency <= ${exp.maxLatencyMs}ms`, detail: `${latencyMs}ms` });
    if (exp.bodyContains) checks.push({ ok: text.includes(exp.bodyContains), label: `body contains "${exp.bodyContains}"`, detail: text.includes(exp.bodyContains) ? 'found' : 'not found' });
    if (exp.headers) {
      for (const [hk, hv] of Object.entries(exp.headers)) {
        const got = respHeaders ? respHeaders.get(hk) : null;
        checks.push({ ok: got != null && got.toLowerCase().includes(String(hv).toLowerCase()), label: `header ${hk} ~ "${hv}"`, detail: `got "${got}"` });
      }
    }
    if (exp.json) {
      for (const [jp, want] of Object.entries(exp.json)) {
        const actual = getPath(json, jp);
        checks.push({ ok: checkJsonExpectation(actual, want), label: `${jp} is ${JSON.stringify(want)}`, detail: `got ${JSON.stringify(actual)}`.slice(0, 120) });
      }
    }
  }

  // --- Captures -------------------------------------------------------------
  if (req.capture && json) {
    for (const [varName, jp] of Object.entries(req.capture)) {
      const v = getPath(json, jp);
      if (v !== undefined) ctx.captured[varName] = v;
    }
  }

  const passed = checks.length > 0 && checks.every((c) => c.ok);
  return { name: req.name || `${method} ${req.path || req.url}`, method, url, status, latencyMs, passed, checks, error };
}

// Run a whole suite. onLog streams human-readable lines. `now` is injected so
// callers control the clock (Date.now is unavailable inside workflow scripts).
async function runSuite(suite, { onLog = () => {}, now = () => Date.now() } = {}) {
  const ctx = { baseUrl: suite.baseUrl || '', variables: suite.variables || {}, captured: {}, now };
  const results = [];
  onLog(`[api] suite "${suite.name || 'unnamed'}" — ${suite.requests?.length || 0} request(s)`);
  for (const req of suite.requests || []) {
    const r = await runRequest(req, ctx);
    results.push(r);
    const mark = r.passed ? '✓' : '✗';
    onLog(`[api] ${mark} ${r.name} — ${r.status} in ${r.latencyMs}ms (${r.checks.filter((c) => c.ok).length}/${r.checks.length} checks)`);
    for (const c of r.checks.filter((x) => !x.ok)) onLog(`[api]     ✗ ${c.label} — ${c.detail}`);
  }
  const passed = results.filter((r) => r.passed).length;
  return {
    suite: suite.name || 'unnamed',
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
  };
}

module.exports = { listSuites, loadSuite, runSuite, runRequest, interpolate, getPath };
