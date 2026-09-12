// Read-only exploratory crawler.
//
// Drives the live app with Playwright and records the surface it can see:
// routes, the roles + accessible names of every control on them, form inputs,
// same-origin links, and any console errors / failed requests observed along
// the way. It never fills an input (beyond the one scripted login), never
// submits a form, never accepts a dialog, and only activates controls that
// lib/explore/safety.js positively recognises as navigation.
//
// Readiness is not incidental here: this app serves a role=status "Loading"
// splash before React hydrates and a cold start routinely runs 8-15s. A naive
// crawler snapshots the splash and reports an empty page, so every navigation
// goes through settle() below.

const { parseAriaSnapshot, dedupeControls } = require('./aria');
const safety = require('./safety');
const { spaWalk } = require('./spa-walk');

// Same auth endpoint features/login-user/login.steps.ts waits on.
const AUTH_API_RE = /security-api\.moontower\.aiimone\.com\/api\/Auth\/Login/i;

const DEFAULTS = {
  mode: 'passive',
  maxRoutes: 25,
  maxDurationMs: 8 * 60 * 1000,
  navTimeoutMs: 45_000,
  settleTimeoutMs: 25_000,
  headless: true,
  // Session-context gates to clear once after login, before crawling.
  //
  // Needed because this app gates its ENTIRE authenticated surface behind a
  // location choice: /inventory, /inventory-vendors and /order-history all
  // redirect to /select-location until one is picked. Without this the crawler
  // can only ever see the picker itself (measured: 5 routes, all redirected).
  //
  // These are declared explicitly rather than by widening safety.NAV_SAFE_NAMES
  // — an app-specific gate should be an auditable list you can read, not a
  // loosened global denylist. Each entry is still checked against the
  // destructive denylist before it is clicked.
  unlock: [{ role: 'button', name: 'Main Location' }],
  // How to move between routes:
  //   'goto' — page.goto() each route. Fine for server-rendered apps.
  //   'spa'  — unlock once then navigate only by clicking. Required whenever a
  //            full document load loses session context; on this app every
  //            goto() bounces to /select-location, so 'goto' can never reach
  //            any authenticated route.
  traversal: 'spa',
};

/**
 * Wait for real content, not merely for the absence of a splash.
 *
 * The previous version did `if (splash.count()) waitFor('hidden')` — a
 * check-then-wait that races. The splash can be absent at check time and
 * render a moment later, so settle() returned "ready" and every subsequent
 * ariaSnapshot captured this and nothing else:
 *
 *   - status:
 *       - img "MoonTower"
 *       - text: Loading
 *
 * which reported every route as having zero controls. Polling for a POSITIVE
 * signal (the body is more than the splash) cannot race that way. Measured: the
 * splash clears in ~2s warm, and the notes on this app record 8-15s cold.
 */
async function settle(page, timeoutMs) {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs });
  } catch { /* keep going — a slow subresource must not abort the crawl */ }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const notReady = await page
      .evaluate(() => {
        const text = document.body ? document.body.innerText.trim() : '';
        // The splash's only text is "Loading" ("MoonTower" is an img alt).
        return text === '' || /^loading\.{0,3}$/i.test(text);
      })
      // Default to NOT ready on error. evaluate() throws "execution context
      // was destroyed" mid-navigation, and defaulting that to "ready" broke
      // out of the poll on the first tick — which is how every route came
      // back with zero controls even after the splash detection was fixed.
      .catch(() => true);
    if (!notReady) break;
    await page.waitForTimeout(250);
  }
  // Small grace so we do not snapshot mid-transition, right as content swaps in.
  await page.waitForTimeout(300).catch(() => {});
  try {
    await page.waitForLoadState('networkidle', { timeout: 3_000 });
  } catch { /* networkidle rarely settles on a live SPA; best-effort only */ }
}

/**
 * Log in once. This is the ONLY place the crawler types into the app.
 * Locators mirror pages/login-user/LoginPage.ts so we stay in sync with the POM.
 */
async function login(page, { baseUrl, email, password, navTimeoutMs, settleTimeoutMs, onLog }) {
  const loginUrl = new URL('/Login', baseUrl).toString();
  onLog(`[explore] logging in at ${loginUrl}`);
  await page.goto(loginUrl, { waitUntil: 'commit', timeout: navTimeoutMs });
  await settle(page, settleTimeoutMs);

  const emailBox = page.getByRole('textbox', { name: 'Email' });
  const passwordBox = page.getByRole('textbox', { name: 'Password' });
  const signIn = page.getByRole('button', { name: 'Sign In' });

  await emailBox.waitFor({ state: 'visible', timeout: settleTimeoutMs });
  await emailBox.fill(email);
  await passwordBox.fill(password);

  // This is a client-side-routed SPA: clicking Sign In fires an XHR and then
  // routes in-page, with NO navigation event. Waiting on load state alone
  // returns instantly and reads the URL as still /Login. So mirror what
  // features/login-user/login.steps.ts does — wait for the auth response —
  // then wait for the route to actually change.
  const authResponse = page
    .waitForResponse((r) => AUTH_API_RE.test(r.url()), { timeout: settleTimeoutMs })
    .catch(() => null);
  await signIn.click();
  const resp = await authResponse;
  const authStatus = resp ? resp.status() : null;

  let landed = safety.normalizeRoute(page.url(), baseUrl);
  if (authStatus && authStatus < 400) {
    try {
      await page.waitForURL((u) => !/\/login\/?$/i.test(new URL(u).pathname), { timeout: settleTimeoutMs });
    } catch { /* fall through — report the URL we actually ended on */ }
    await settle(page, settleTimeoutMs);
    landed = safety.normalizeRoute(page.url(), baseUrl);
  }

  const ok = !!landed && !/^\/login$/i.test(landed);
  if (ok) {
    onLog(`[explore] logged in (auth ${authStatus}), landed on ${landed}`);
  } else {
    // Distinguish "credentials rejected" from "app never routed" — they need
    // completely different fixes and both look like "login failed".
    let onPageError = '';
    try {
      const alert = page.getByRole('alert').first();
      if (await alert.count()) onPageError = (await alert.innerText()).trim().slice(0, 160);
    } catch { /* ignore */ }
    const why = authStatus === null
      ? 'no auth API response observed within timeout'
      : authStatus >= 400
        ? `auth API returned ${authStatus} — credentials rejected`
        : `auth API returned ${authStatus} but the app never left /Login`;
    onLog(`[explore] login failed: ${why}${onPageError ? ` | page says: "${onPageError}"` : ''}`);
    return { ok: false, landed, authStatus, why, onPageError };
  }
  return { ok, landed, authStatus };
}

/** Snapshot one already-loaded page into a route record. */
async function captureRoute(page, route, baseUrl, mode, observed) {
  let snapshot = '';
  try {
    snapshot = await page.locator('body').ariaSnapshot({ timeout: 15_000 });
  } catch (err) {
    return { route, error: `ariaSnapshot failed: ${err.message.split('\n')[0]}` };
  }

  const nodes = parseAriaSnapshot(snapshot);
  const deduped = dedupeControls(nodes).filter(
    (c) => safety.INTERESTING_ROLES.has(c.role) && (c.name || c.role === 'table')
  );

  const controls = deduped.map((c) => {
    const cls = safety.classifyControl(c.role, c.name, mode);
    return {
      role: c.role,
      name: c.name,
      count: c.count,
      destructive: cls.destructive,
      input: cls.input,
      navSafe: cls.navSafe,
    };
  });

  // Same-origin links become crawl candidates.
  const links = [];
  for (const n of nodes) {
    if (!n.url) continue;
    if (!safety.isSameOriginUrl(n.url, baseUrl)) continue;
    const norm = safety.normalizeRoute(n.url, baseUrl);
    if (norm && !links.includes(norm)) links.push(norm);
  }

  let title = '';
  try { title = await page.title(); } catch { /* ignore */ }

  return {
    route,
    url: page.url(),
    title,
    controls,
    links,
    headings: nodes.filter((n) => n.role === 'heading' && n.name).map((n) => n.name).slice(0, 12),
    inputCount: controls.filter((c) => c.input).length,
    destructiveCount: controls.filter((c) => c.destructive).length,
    consoleErrors: observed.consoleErrors.splice(0),
    failedRequests: observed.failedRequests.splice(0),
  };
}

async function runCrawl(opts = {}) {
  // Strip undefined before merging. A caller that forwards an unset option
  // (unlock: opts.unlock) would otherwise overwrite the default with undefined
  // and silently disable it — which is exactly how the location-gate unlock
  // stopped running while still looking configured.
  const provided = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined));
  const cfg = { ...DEFAULTS, ...provided };
  const onLog = cfg.onLog || (() => {});
  const { chromium } = require('@playwright/test');

  if (!cfg.baseUrl) throw new Error('runCrawl: baseUrl is required');
  if (!['passive', 'guarded'].includes(cfg.mode)) {
    throw new Error(`runCrawl: mode must be passive|guarded (got ${cfg.mode})`);
  }

  const startedAt = Date.now();
  const deadline = startedAt + cfg.maxDurationMs;
  const routes = [];
  const skipped = [];
  const visited = new Set();
  const queue = [];

  const seeds = (cfg.seeds || []).map((s) => safety.normalizeRoute(s, cfg.baseUrl)).filter(Boolean);
  for (const s of seeds) if (!queue.includes(s)) queue.push(s);

  let browser;
  const observed = { consoleErrors: [], failedRequests: [] };

  try {
    browser = await chromium.launch({ headless: cfg.headless });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    // Never let a dialog block the crawl, and never accept one — accepting
    // could confirm a destructive action.
    page.on('dialog', (d) => { d.dismiss().catch(() => {}); });
    page.on('console', (m) => {
      if (m.type() === 'error') observed.consoleErrors.push(m.text().slice(0, 300));
    });
    page.on('requestfailed', (r) => {
      observed.failedRequests.push(`${r.method()} ${r.url().slice(0, 200)}`);
    });
    page.on('response', (r) => {
      if (r.status() >= 500) observed.failedRequests.push(`${r.status()} ${r.url().slice(0, 200)}`);
    });

    const auth = await login(page, {
      baseUrl: cfg.baseUrl,
      email: cfg.email,
      password: cfg.password,
      navTimeoutMs: cfg.navTimeoutMs,
      settleTimeoutMs: cfg.settleTimeoutMs,
      onLog,
    });
    if (!auth.ok) {
      return {
        ok: false,
        error: `login failed — ${auth.why || 'unknown reason'} (crawl aborted before visiting any route)`,
        login: auth,
        routes: [], skipped: [], mode: cfg.mode,
        stats: { durationMs: Date.now() - startedAt, routesVisited: 0 },
      };
    }
    // Whatever the app redirected us to is a real route worth crawling.
    if (auth.landed && !queue.includes(auth.landed)) queue.unshift(auth.landed);

    // Clear session-context gates (e.g. the location picker) so the rest of the
    // app becomes reachable. Refuses anything on the destructive denylist.
    const unlockLog = [];
    for (const step of cfg.unlock || []) {
      if (safety.isHardBlocked(step.name)) {
        unlockLog.push({ ...step, done: false, reason: 'destructive-denylist' });
        onLog(`[explore] REFUSED unlock step ${step.role} "${step.name}" — matches the destructive denylist`);
        continue;
      }
      try {
        const loc = page.getByRole(step.role, { name: step.name, exact: true }).first();
        await loc.waitFor({ state: 'visible', timeout: cfg.settleTimeoutMs });
        const beforeUrl = page.url();

        // Retry the click. On this SPA a control is visible before React binds
        // its handler, so a first click can land as a no-op — seen as an
        // aborted POST /api/Auth/LocationSelection and a URL that never moves.
        // Playwright's auto-waiting cannot see handler binding, so the only
        // reliable signal is "did the route change", and the fix is to click
        // again if it did not.
        // Compare PATHNAMES, not full URLs: this app mutates the query string
        // without leaving the picker, which made a full-string compare report
        // "moved" while still gated.
        const beforePath = safety.normalizeRoute(beforeUrl, cfg.baseUrl);
        let moved = false;
        for (let attempt = 1; attempt <= 3 && !moved; attempt++) {
          if (attempt > 1) onLog(`[explore]   retrying "${step.name}" (attempt ${attempt}) — route did not change`);
          await loc.click({ timeout: 10_000 }).catch(() => {});
          moved = await page
            .waitForURL((u) => safety.normalizeRoute(u, cfg.baseUrl) !== beforePath, { timeout: 10_000 })
            .then(() => true)
            .catch(() => false);
        }
        await settle(page, cfg.settleTimeoutMs);
        const now = safety.normalizeRoute(page.url(), cfg.baseUrl);
        unlockLog.push({ ...step, done: moved, landedOn: now });
        onLog(
          moved
            ? `[explore] unlocked via ${step.role} "${step.name}" -> ${now}`
            : `[explore] unlock "${step.name}" clicked but the route never changed (still ${now}) — the gated surface will stay hidden`
        );
        if (now && !visited.has(now) && !queue.includes(now)) queue.unshift(now);
      } catch (err) {
        unlockLog.push({ ...step, done: false, reason: err.message.split('\n')[0] });
        onLog(`[explore] unlock step ${step.role} "${step.name}" did not apply: ${err.message.split('\n')[0]}`);
      }
    }
    cfg.__unlockLog = unlockLog;

    if (cfg.traversal === 'spa') {
      // Re-clear the gate after a bounce, reusing the same declared unlock
      // steps (and the same denylist check) as the initial unlock.
      const reUnlock = async () => {
        let ok = false;
        for (const step of cfg.unlock || []) {
          if (safety.isHardBlocked(step.name)) continue;
          try {
            const loc = page.getByRole(step.role, { name: step.name, exact: true }).first();
            await loc.waitFor({ state: 'visible', timeout: 12_000 });
            const beforePath = safety.normalizeRoute(page.url(), cfg.baseUrl);
            for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
              await loc.click({ timeout: 8_000 }).catch(() => {});
              ok = await page
                .waitForURL((u) => safety.normalizeRoute(u, cfg.baseUrl) !== beforePath, { timeout: 8_000 })
                .then(() => true)
                .catch(() => false);
            }
          } catch { /* leave ok false — caller records the failure */ }
        }
        return ok;
      };

      const walk = await spaWalk(page, cfg, { onLog, observed, reUnlock, settle });
      return {
        ok: true,
        mode: cfg.mode,
        traversal: 'spa',
        baseUrl: cfg.baseUrl,
        unlock: unlockLog,
        routes: walk.routes,
        skipped: walk.skipped,
        stats: {
          durationMs: Date.now() - startedAt,
          routesVisited: walk.routes.length,
          routesQueuedUnvisited: 0,
          controlsSeen: walk.routes.reduce((n, r) => n + ((r.controls || []).length), 0),
          cappedAtRoutes: walk.routes.length >= cfg.maxRoutes,
        },
      };
    }

    while (queue.length && routes.length < cfg.maxRoutes) {
      if (Date.now() > deadline) {
        onLog(`[explore] time budget reached (${Math.round(cfg.maxDurationMs / 1000)}s) — stopping with ${queue.length} route(s) unvisited`);
        for (const r of queue) skipped.push({ route: r, reason: 'time-budget' });
        break;
      }
      const route = queue.shift();
      if (visited.has(route)) continue;
      visited.add(route);

      const target = new URL(route, cfg.baseUrl).toString();
      onLog(`[explore] (${routes.length + 1}/${cfg.maxRoutes}) ${route}`);
      try {
        await page.goto(target, { waitUntil: 'commit', timeout: cfg.navTimeoutMs });
        await settle(page, cfg.settleTimeoutMs);
      } catch (err) {
        routes.push({ route, error: `navigation failed: ${err.message.split('\n')[0]}` });
        continue;
      }

      // A redirect (e.g. back to /Login when a route needs a location choice)
      // means this route is not independently reachable — worth recording.
      const actual = safety.normalizeRoute(page.url(), cfg.baseUrl);
      if (actual && actual !== route && visited.has(actual)) {
        // Redirected somewhere we already captured — record the gate without
        // spending budget re-snapshotting identical content.
        routes.push({ route, redirectedTo: actual, gated: true, controls: [], links: [], headings: [], inputCount: 0, destructiveCount: 0, consoleErrors: [], failedRequests: [] });
        continue;
      }
      const rec = await captureRoute(page, route, cfg.baseUrl, cfg.mode, observed);
      if (actual && actual !== route) {
        rec.redirectedTo = actual;
        visited.add(actual);
      }
      routes.push(rec);

      for (const link of rec.links || []) {
        if (!visited.has(link) && !queue.includes(link)) queue.push(link);
      }

      if (cfg.mode === 'guarded') {
        const clickable = (rec.controls || []).filter(
          (c) => safety.classifyControl(c.role, c.name, 'guarded').clickable
        );
        for (const c of (rec.controls || [])) {
          const cls = safety.classifyControl(c.role, c.name, 'guarded');
          if (!cls.clickable) skipped.push({ route, control: `${c.role} "${c.name}"`, reason: cls.reason });
        }
        // Activate nav-safe controls to reveal routes no URL points at.
        for (const c of clickable.slice(0, 8)) {
          if (Date.now() > deadline) break;
          try {
            const before = page.url();
            await page.getByRole(c.role, { name: c.name, exact: true }).first()
              .click({ timeout: 8_000, noWaitAfter: true });
            await settle(page, 8_000);
            const after = page.url();
            if (after !== before) {
              if (!safety.isSameOriginUrl(after, cfg.baseUrl)) {
                await page.goBack({ timeout: cfg.navTimeoutMs }).catch(() => {});
              } else {
                const discovered = safety.normalizeRoute(after, cfg.baseUrl);
                if (discovered && !visited.has(discovered) && !queue.includes(discovered)) {
                  queue.push(discovered);
                  onLog(`[explore]   + ${discovered}  (via ${c.role} "${c.name}")`);
                }
                await page.goto(target, { waitUntil: 'commit', timeout: cfg.navTimeoutMs }).catch(() => {});
                await settle(page, cfg.settleTimeoutMs);
              }
            }
          } catch {
            // A control that will not activate is not a crawl failure.
          }
        }
      } else {
        for (const c of (rec.controls || [])) {
          if (c.destructive) skipped.push({ route, control: `${c.role} "${c.name}"`, reason: 'destructive-denylist' });
        }
      }
    }

    for (const r of queue) {
      if (!visited.has(r)) skipped.push({ route: r, reason: routes.length >= cfg.maxRoutes ? 'route-cap' : 'unvisited' });
    }

    return {
      ok: true,
      mode: cfg.mode,
      baseUrl: cfg.baseUrl,
      unlock: cfg.__unlockLog || [],
      routes,
      skipped,
      stats: {
        durationMs: Date.now() - startedAt,
        routesVisited: routes.length,
        routesQueuedUnvisited: queue.length,
        controlsSeen: routes.reduce((n, r) => n + ((r.controls || []).length), 0),
        cappedAtRoutes: routes.length >= cfg.maxRoutes,
      },
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { runCrawl, settle, DEFAULTS };
