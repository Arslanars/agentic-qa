// Custom Playwright reporter that emits per-step lifecycle events as
// newline-delimited JSON on stdout, prefixed with [LIVE_STEP] so the UI
// server can distinguish them from regular log output and forward them
// as structured events to the browser.
//
// This is what powers the "Liquid Gherkin Step Timeline" — the vertical
// panel that shows each Given/When/Then beam filling in real-time as
// playwright-bdd executes the scenario.
//
// Events emitted (one JSON per line):
//   { ev: 'testStart',  testId, title, file }
//   { ev: 'stepStart',  testId, stepId, title, at }
//   { ev: 'stepEnd',    testId, stepId, title, durationMs, error, at }
//   { ev: 'testEnd',    testId, status, durationMs }

class LiveStepReporter {
  printsToStdio() { return true; }

  onTestBegin(test) {
    this._emit({ ev: 'testStart', testId: test.id, title: test.title, file: (test.location && test.location.file) || '' });
  }

  onStepBegin(test, _result, step) {
    // Only emit the "outer" Gherkin steps (Given/When/Then/And/But). Skip
    // playwright-internal categories like 'hook' and 'fixture' to keep the
    // UI timeline focused on user-visible steps.
    if (step.category !== 'test.step') return;
    this._emit({
      ev: 'stepStart',
      testId: test.id,
      stepId: this._stepId(step),
      title: step.title,
      at: Date.now(),
    });
  }

  onStepEnd(test, _result, step) {
    if (step.category !== 'test.step') return;
    this._emit({
      ev: 'stepEnd',
      testId: test.id,
      stepId: this._stepId(step),
      title: step.title,
      durationMs: step.duration,
      error: step.error ? String(step.error.message || step.error).slice(0, 240) : null,
      at: Date.now(),
    });
  }

  onTestEnd(test, result) {
    this._emit({
      ev: 'testEnd',
      testId: test.id,
      status: result.status,
      durationMs: result.duration,
    });
  }

  _stepId(step) {
    // Playwright doesn't surface a stable step id; compose one from the
    // title + start time so the same step in two runs doesn't collide.
    return `${step.title}@${step.startTime ? step.startTime.getTime() : 0}`;
  }

  _emit(payload) {
    try {
      process.stdout.write(`[LIVE_STEP]${JSON.stringify(payload)}\n`);
    } catch (_) { /* best-effort; reporter errors mustn't crash the run */ }
  }
}

module.exports = LiveStepReporter;
