---
name: test-discipline
description: Дисциплина написания и поддержки автоматизированных тестов.
---

# test-discipline

Rules for writing and maintaining automated tests — new features, bug fixes,
edge-case grids, coverage audits. Language- and framework-agnostic.

## A test that was never red tests nothing

- Bug fix: write the failing test first, watch it fail with the expected diff
  (`Expected: "[[archive/plan.md]]" / Received: "[[docs/plan.md]]"`), then fix.
  A test written after the fix, mirroring it, encodes the fix as spec — if the
  fix is wrong, the test is its accomplice.
- Tests written over already-green code (edge-case grids, behavior pinning)
  never turn red on their own. Earn their red with a mutation pass.

## Mutation pass — manual, cheap, per test batch

1. Pick 5–12 targeted mutations of the implementation the batch claims to
   cover. One semantic break each: invert a branch, drop a guard, cut
   recursion, disable a feature, weaken exact match to `includes`. Not syntax
   noise.
2. Apply one mutation → run only the affected test files → record which tests
   went red → revert. `git checkout <file>` also reverts any uncommitted fix
   in that file — re-apply it and re-run before continuing.
3. Every test in the batch must go red under at least one mutation. Keep the
   matrix (mutation → red tests) and put it in the commit message.
4. A surviving mutant is never shrugged off. Two outcomes only:
   - **Equivalent** — name the second defence layer that masks it (an index
     that pre-filters input, a wrapper that flattens promises). Prove the
     layer is real with a double mutation: break both layers at once and show
     which tests hold the last line.
   - **Gap** — the analysis of *why* it survived usually points at an input
     class no test produces. Write that test; expect it to expose a live bug,
     not just missing coverage.

## Red-first does not validate the spec

Red proves the test detects the change — not that the change is right.

- Changing the semantics of a shared primitive: enumerate its callers first.
  Every caller's expectation needs a test **before** the change; where none
  exists, pin current behavior, then change and watch which pins break. A
  suite that stays silent after a semantic change to a shared contract is a
  warning, not a pass.
- The fix that satisfies the scenario in front of you can break a sibling
  caller whose expectation was never written down. The guard belongs where
  the distinguishing knowledge lives (usually the call site), not as a
  blanket rule inside the primitive.

## Invariant suites beat scenario sampling

A mutation pass measures the tests you have; it cannot see scenarios you
never wrote. Encode system properties as their own suite:

- **Round-trip identity**: any do-then-undo sequence is an observable no-op
  (empty plan, zero writes, neighbours untouched). Mandatory for systems that
  collapse or journal operations.
- **Idempotence**: applying twice equals applying once.
- Escalation when the hand-written identity suite feels sparse: generate
  random operation sequences plus their inverses (fast-check style) against
  the same invariants — shrinking returns the minimal counterexample.

## Pin behavior at the edges

- A gap you found but are not fixing (feature absent, warning-only path):
  pin it with explicit asserts — including negative ones («no warning», «not
  rewritten») — so a future change flips a test instead of shipping silently.
- Assert full shapes with strict equality, not `toMatchObject` / property
  presence: a fake that structurally resembles the expected output passes a
  partial match and the test survives an identity mutation.
- Deriving the expectation from the code under test at runtime makes the
  test self-fulfilling. Hardcode expectations; where discovery is genuinely
  needed (nondeterministic ownership, load order), keep it one-sided —
  discover the subject, then assert its full expected shape strictly.

## Loop hygiene

- File-scoped runs inside the loop; full suite + typecheck before commit.
- Test names state the contract («returning a note to its origin collapses
  to a no-op apply»), not the mechanics («registerEdit overwrites move»).
