# Routing benchmark — 2026-10-18 re-verification before merging #231

Not a new routing change. PR #231 (`maxspeed` unit parsing + 40 km/h calmed-street
ceiling) was approved for merge today having sat green since 2026-08-22, so the
gate was re-run against current `main` before landing it.

**Why re-run at all:** the PR's CI check was from 2026-08-23. A green check is
evidence about the commit it ran on, not about merging into today's `main`.

**Result: PASS.** Routes-found holds at 22/22 (Berlin) and 17/17 (SF) on every
mode. No mode lost preferred-%.

## What moved underneath the branch

`main` gained 5 commits since the branch's last commit, none of them touching a
file the routing gate names:

```
986e5fb chore(deps): bump source-map-js (#238)
3964989 fix(worker): put openstreetmap.fr first (#240)
24a1f16 Merge pull request #237 (deploy unjam)
852efe4 fix(ci): drop wrangler secret-bulk step
4edb3ee fix(worker): Overpass fallback (#236)
```

`git diff --name-only HEAD...origin/main` over `clientRouter.ts`, `modes.ts`,
`lts.ts`, `classify.ts`, `overpass.ts` and `cityProfiles/` is empty. So no
routing code changed under the branch, and the 2026-08-22 file remains the
newest benchmark in the repo and the right comparison base.

## SF (17 pairs) — reproduces the recorded figures exactly

| Mode | Found | Preferred: recorded → today | Walk: recorded → today |
|------|-------|------------------------------|------------------------|
| kid-starting-out  | 17/17 | 28% → 28% | 60% → 60% |
| kid-confident     | 17/17 | 41% → 41% | 49% → 49% |
| kid-traffic-savvy | 17/17 | 61% → 61% | 1% → 1% |
| carrying-kid      | 17/17 | 54% → 54% | 2% → 2% |
| training          | 17/17 | 51% → 51% | 3% → 0% |

Every preferred-% figure matches the 2026-08-22 "after" column. Only training's
walk-% differs, 3pp downward.

The two youngest modes hold at 28% and 41% preferred with 60% and 49% walk —
unchanged, which is the check that matters for the safety argument. Raising the
2a ceiling re-labels roads they were already riding; it does not route them
anywhere new.

## Berlin (22 pairs) — within normal data drift

| Mode | Found | Preferred: recorded → today | LTS 2a |
|------|-------|------------------------------|--------|
| kid-starting-out  | 22/22 | 52% → 52% | 4% → 4% |
| kid-confident     | 22/22 | 66% → 66% | 4% → 4% |
| kid-traffic-savvy | 22/22 | 67% → 68% | 5% → 5% |
| carrying-kid      | 22/22 | 57% → 60% | 5% → 5% |
| training          | 22/22 | 46% → 46% | 6% → 6% |

Two modes rose, by 1pp and 3pp. Both moves are upward, so neither approaches the
gate's ">3pp drop" threshold, and the LTS 2a column is identical on every mode —
which is what rules the tier change out as the cause. The benchmark fetches live
Overpass tiles, so two months of OSM edits are the expected explanation; the
2026-08-22 file records the same scale of drift against its own July baseline
(50/66/67/56/46 → 52/66/67/57/46).

Berlin is also the city where this change provably does nothing: per the
2026-08-22 analysis only 3 of 40,600 central-Berlin ways change pathLevel,
because Berlin posts 30 or 50 and nothing sits between.

## Limits of this run

- **Branch-only, not a paired main-vs-branch diff.** The 2026-08-22 file measured
  the delta; this run measures whether the branch still produces those numbers.
  Read it as "the figures reproduce", not as a re-measured delta.
- `--no-external`, so Valhalla and BRouter comparisons were skipped. They are
  benchmark-only and not on the app's path.
- The rendering evidence on #231 is still weak for the reason its own reviewer
  note gives: the render-check harness can produce a false green and two of its
  gates cannot fail as written. Repairing that is #232. Nothing in this run
  addresses it.

## Also run

`bunx tsc --noEmit` clean. `bun test` 796 pass / 0 fail.
