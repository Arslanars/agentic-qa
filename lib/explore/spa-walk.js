// In-app (SPA) traversal.
//
// Why this exists: this app holds its selected location in in-memory React
// state only — localStorage carries just `moontower_token`, and nothing else
// persists it. So every full document load bounces back to /select-location.
// Traced directly:
//
//   goto('/inventory')  ->  [nav] /inventory  ->  [nav] /select-location
//
// A goto-based crawler therefore cannot see any authenticated surface on this
// app, no matter how many routes you seed it with. The only way in is to unlock
// once and then move around by clicking, never hard-loading.
//
// So: hold one page, click nav-safe controls, and record each new route as it
// appears. If a click bounces us back to the gate, re-run the unlock and carry
// on rather than aborting the crawl.

const { parseAriaSnapshot, dedupeControls } = require('./aria');
const safety = require('./safety');

/** Snapshot whatever route the page is currently on. */
async function captureCurrent(page, baseUrl, mode, observed) {
  const route = safety.normalizeRoute(page.url(), baseUrl);
  let snapshot = '';
  try {
    snapshot = await page.locator('body').ariaSnapshot({ timeout: 15_000 });
  } catch (err) {
    return { route, error: `ariaSnapshot failed: ${err.message.split('\n')[0]}` };
  }

  const nodes = parseAriaSnapshot(snapshot);
  const controls = dedupeControls(nodes)
    .filter((c) => safety.INTERESTING_ROLES.has(c.role) && (c.name || c.role === 'table'))
    .map((c) => {
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

  const links = [];
  for (const n of nodes) {
    if (!n.url || !safety.isSameOriginUrl(n.url, baseUrl)) continue;
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

/**
 * Walk the app by clicking. Never calls page.goto().
 *
 * @param deps.reUnlock async () => boolean  — clears the session gate again
 *                      after a bounce; returns whether it worked.
 */
async function spaWalk(page, cfg, deps) {
  const { onLog, observed, reUnlock, settle } = deps;
  const routes = [];
  const skipped = [];
  const visited = new Set();
  // Controls we have already followed, keyed route|role|name, so a nav item
  // present in the shell on every page is not clicked once per page forever.
  const followed = new Set();
  const deadline = Date.now() + cfg.maxDurationMs;

  const gateRe = /select-location/i;

  // Settle before the first capture too — the unlock click leaves the app
  // mid-hydration, and snapshotting there records the splash instead of the page.
  await settle(page, cfg.settleTimeoutMs);
  let current = await captureCurrent(page, cfg.baseUrl, cfg.mode, observed);
  if (current.route) {
    visited.add(current.route);
    routes.push(current);
    onLog(`[explore] (1/${cfg.maxRoutes}) ${current.route}  ${current.controls ? current.controls.length : 0} control(s)`);
  }

  // In passive mode nothing is clickable by contract, so an SPA walk cannot
  // move: it reports the landing route only. Say so rather than silently
  // returning a one-route crawl that looks like the app has no other pages.
  if (cfg.mode === 'passive') {
    onLog('[explore] passive mode: no clicks, so only the landing route is reachable on a client-routed app. Re-run with --guarded to walk the nav.');
    return { routes, skipped, visited };
  }

  while (routes.length < cfg.maxRoutes && Date.now() < deadline) {
    // Candidate nav controls on the page we are standing on.
    const candidates = (current.controls || []).filter((c) => {
      if (!safety.classifyControl(c.role, c.name, cfg.mode).clickable) return false;
      return !followed.has(`${current.route}|${c.role}|${c.name}`);
    });

    if (!candidates.length) {
      // Nothing left to try from here. Fall back to any unfollowed control on
      // an already-captured route by returning there via its own nav item.
      const pending = [];
      for (const r of routes) {
        for (const c of r.controls || []) {
          if (!safety.classifyControl(c.role, c.name, cfg.mode).clickable) continue;
          if (!followed.has(`${r.route}|${c.role}|${c.name}`)) pending.push({ r, c });
        }
      }
      if (!pending.length) break;
      // Mark them followed so we cannot loop forever on unreachable pending work.
      for (const p of pending) followed.add(`${p.r.route}|${p.c.role}|${p.c.name}`);
      continue;
    }

    const control = candidates[0];
    followed.add(`${current.route}|${control.role}|${control.name}`);

    const beforePath = safety.normalizeRoute(page.url(), cfg.baseUrl);
    try {
      const loc = page.getByRole(control.role, { name: control.name, exact: true }).first();
      if (!(await loc.count())) continue;
      await loc.click({ timeout: 8_000 });
      await page
        .waitForURL((u) => safety.normalizeRoute(u, cfg.baseUrl) !== beforePath, { timeout: 8_000 })
        .catch(() => {});
      await settle(page, 12_000);
    } catch {
      continue; // a control that will not activate is not a crawl failure
    }

    const nowPath = safety.normalizeRoute(page.url(), cfg.baseUrl);

    // Off-origin: get back in-app without a hard load.
    if (!safety.isSameOriginUrl(page.url(), cfg.baseUrl)) {
      await page.goBack({ timeout: cfg.navTimeoutMs }).catch(() => {});
      await settle(page, 10_000);
      current = await captureCurrent(page, cfg.baseUrl, cfg.mode, observed);
      continue;
    }

    // Bounced to the session gate — re-unlock and continue from wherever it lands.
    if (gateRe.test(nowPath || '')) {
      onLog(`[explore]   bounced to the location gate after "${control.name}" — re-unlocking`);
      const ok = await reUnlock();
      await settle(page, 12_000);
      current = await captureCurrent(page, cfg.baseUrl, cfg.mode, observed);
      if (!ok) {
        skipped.push({ route: nowPath, reason: 'gate-reunlock-failed' });
        break;
      }
      if (current.route && !visited.has(current.route)) {
        visited.add(current.route);
        routes.push(current);
      }
      continue;
    }

    if (nowPath && !visited.has(nowPath)) {
      visited.add(nowPath);
      current = await captureCurrent(page, cfg.baseUrl, cfg.mode, observed);
      routes.push(current);
      onLog(
        `[explore] (${routes.length}/${cfg.maxRoutes}) ${current.route}  ` +
        `${(current.controls || []).length} control(s)  (via ${control.role} "${control.name}")`
      );
    } else {
      // Same route (a tab that swaps content in place). Re-capture so the new
      // controls are recorded against it, then merge.
      const again = await captureCurrent(page, cfg.baseUrl, cfg.mode, observed);
      const existing = routes.find((r) => r.route === again.route);
      if (existing && again.controls) {
        const seen = new Set(existing.controls.map((c) => `${c.role}|${c.name}`));
        for (const c of again.controls) {
          if (!seen.has(`${c.role}|${c.name}`)) existing.controls.push(c);
        }
        existing.inputCount = existing.controls.filter((c) => c.input).length;
        existing.destructiveCount = existing.controls.filter((c) => c.destructive).length;
      }
      current = again;
    }
  }

  // Everything we refused to touch is a candidate scenario for a human.
  for (const r of routes) {
    for (const c of r.controls || []) {
      const cls = safety.classifyControl(c.role, c.name, cfg.mode);
      if (!cls.clickable) {
        skipped.push({ route: r.route, control: `${c.role} "${c.name}"`, reason: cls.reason });
      }
    }
  }

  return { routes, skipped, visited };
}

module.exports = { spaWalk, captureCurrent };
