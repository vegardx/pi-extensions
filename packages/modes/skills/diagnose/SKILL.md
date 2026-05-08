---
name: diagnose
description: Disciplined diagnosis loop for hard bugs and performance regressions. Reproduce → minimise → hypothesise → instrument → fix → regression-test. Use when user says "diagnose this", "debug this", reports a bug, says something is broken/throwing/failing, or describes a performance regression.
---

<!-- Adapted from mattpocock/skills (MIT) — https://github.com/mattpocock/skills -->

# Diagnose

A discipline for hard bugs. Skip phases only when explicitly justified.

## Phase 1 — Build a feedback loop

**This is the skill.** Everything else is mechanical. If you have a fast,
deterministic, agent-runnable pass/fail signal for the bug, you will find
the cause. If you don't have one, no amount of staring at code will save you.

Spend disproportionate effort here. Be aggressive. Be creative.

### Ways to construct one — try in roughly this order

1. **Failing test** at whatever seam reaches the bug — unit, integration, e2e.
2. **CLI invocation** with a fixture input, diffing stdout against known-good.
3. **Curl / HTTP script** against a running dev server.
4. **Headless browser script** (Playwright / Puppeteer) — drives UI, asserts on DOM/console/network.
5. **Replay a captured trace.** Save a real payload / event log to disk; replay through the code path in isolation.
6. **Throwaway harness.** Spin up a minimal subset (one service, mocked deps) that exercises the bug code path.
7. **Property / fuzz loop.** If the bug is "sometimes wrong output", run 1000 random inputs and look for the failure mode.
8. **Bisection harness.** If the bug appeared between two known states, automate "boot at state X, check, repeat" for `git bisect run`.
9. **Differential loop.** Run the same input through old-version vs new-version and diff outputs.

### Iterate on the loop itself

Treat the loop as a product:

- Can I make it faster? (Cache setup, skip unrelated init, narrow scope.)
- Can I make the signal sharper? (Assert on the specific symptom, not "didn't crash".)
- Can I make it more deterministic? (Pin time, seed RNG, isolate filesystem.)

A 30-second flaky loop is barely better than no loop. A 2-second deterministic loop is a debugging superpower.

### Non-deterministic bugs

The goal is a **higher reproduction rate**. Loop the trigger 100×, parallelise, add stress, narrow timing windows. A 50%-flake is debuggable; 1% is not.

### When you genuinely cannot build a loop

Stop and say so explicitly. List what you tried. Ask for: (a) access to the reproducing environment, (b) a captured artifact (log dump, HAR, screen recording), or (c) permission to add temporary instrumentation. Do **not** proceed to hypothesise without a loop.

## Phase 2 — Reproduce

Run the loop. Watch the bug appear. Confirm:

- [ ] The loop produces the failure the **user** described — not a nearby different failure.
- [ ] The failure is reproducible across multiple runs (or at high enough rate for non-deterministic bugs).
- [ ] You have captured the exact symptom (error message, wrong output, timing) for later verification.

Do not proceed until you reproduce.

## Phase 3 — Hypothesise

Generate **3–5 ranked hypotheses** before testing any. Single-hypothesis generation anchors on the first plausible idea.

Each hypothesis must be **falsifiable**: state the prediction.

> Format: "If <X> is the cause, then <changing Y> will make the bug disappear / <changing Z> will make it worse."

**Show the ranked list to the user before testing.** They often have domain knowledge that re-ranks instantly.

## Phase 4 — Instrument

Each probe maps to a specific prediction from Phase 3. **Change one variable at a time.**

Tool preference:

1. Debugger / REPL inspection if available. One breakpoint beats ten logs.
2. Targeted logs at boundaries that distinguish hypotheses.
3. Never "log everything and grep."

**Tag every debug log** with a unique prefix, e.g. `[DBG-a4f2]`. Cleanup at the end becomes a single grep.

**Perf bugs:** logs are usually wrong. Establish a baseline measurement (timing harness, profiler, query plan), then bisect. Measure first, fix second.

## Phase 5 — Fix + regression test

Write the regression test **before the fix** — but only if there is a correct seam for it (one where the test exercises the real bug pattern at the call site).

If no correct seam exists, that itself is the finding. Note it.

1. Turn the minimised repro into a failing test at the correct seam.
2. Watch it fail.
3. Apply the fix.
4. Watch it pass.
5. Re-run the Phase 1 feedback loop against the original scenario.

## Phase 6 — Cleanup

Required before declaring done:

- [ ] Original repro no longer reproduces (re-run Phase 1 loop)
- [ ] Regression test passes (or absence of seam is documented)
- [ ] All `[DBG-...]` instrumentation removed (grep the prefix)
- [ ] Throwaway prototypes deleted
- [ ] The correct hypothesis is stated in the commit message

**Then ask: what would have prevented this bug?** If the answer involves architectural change, note it for a future `/improve` session.
