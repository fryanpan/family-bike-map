# 2026-04-29 Joanna routing changes — benchmark

> Source-of-truth for what each commit was supposed to do:
> `docs/product/user-research/joanna.md` (Solutions table + Followups).
> All four routing-quality changes from Joanna's 2026-04-29 chat shipped
> together on `joanna-routing-changes`.

## Commits in this run

1. `04a876b` — docs(legend): document carrying-kid elevated-sidewalk placement (#5a)
2. `23a0bc9` — feat(routing): training mode `levelMultipliers` (#5b)
3. `cd7c163` — feat(classify): demote separated PBLs on busy arterials to 2a (#3)
4. `49bca61` — feat(routing): unsignalized-major-road intersection penalty (#4)
5. `19b504f` — fix(routing): skip the #4 penalty on walking edges (regression diagnosis)

## Methodology

The most recent saved benchmark (`2026-04-23-smoothness-routing-benchmark.md`)
ran via the Cloudflare Worker proxy, which caches Overpass responses by
`(row, col)` and ignores changes in the query body. After commit 4 added a
`node[highway=traffic_signals]` sub-query, the Worker kept serving stale
ways-only responses, so I switched the benchmark script to hit Overpass
directly. To make the comparison fair I re-ran `main` against direct
Overpass too — those are the "Baseline" rows below. Calling the
`2026-04-23` numbers "the previous baseline" would mix the routing change
with the data-source change.

Berlin: 22 routes (10 destinations × 2 origins + 2 extras) plus the
single-origin SF (17 destinations).

## Berlin — per-mode

| Mode | Routes | Avg distance | Baseline pref% | Post-fix pref% | Δ | Baseline walk% | Post-fix walk% |
|------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| kid-starting-out | 22/22 | 5.9 km | 56% | **17%** | **−39pp** | 44% | 83% |
| kid-confident | 22/22 | 6.5 km | 67% | **47%** | **−20pp** | 31% | 53% |
| kid-traffic-savvy | 22/22 | 5.6 km | 64% | 63% | −1pp | 13% | 14% |
| carrying-kid | 22/22 | 5.9 km | 54% | 53% | −1pp | 20% | 21% |
| training | 22/22 | 6.0 km | 49% | 50% | +1pp | 6% | 6% |

Routes-found: unchanged at 22/22 across the board (no connectivity loss).

## San Francisco — per-mode

| Mode | Routes | Avg distance | Baseline pref% | Post-fix pref% | Δ | Baseline walk% | Post-fix walk% |
|------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| kid-starting-out | 17/17 | 5.4 km | 31% | **24%** | **−7pp** | 67% | 74% |
| kid-confident | 17/17 | 5.6 km | 47% | **38%** | **−9pp** | 51% | 57% |
| kid-traffic-savvy | 17/17 | 5.3 km | 46% | 46% | 0pp | 1% | 1% |
| carrying-kid | 17/17 | 5.3 km | 32% | 32% | 0pp | 1% | 1% |
| training | 17/17 | 5.3 km | 31% | 33% | +2pp | 1% | 1% |

Routes-found: unchanged at 17/17.

## Spot-check — the original Joanna case (`scripts/debug-rudower-ch.ts`)

Start corrected to **Dresdener Str 112, Kreuzberg** (was Brandenburg
Gate). Direct distance 10.27 km, 16 tiles fetched, ~6,000 traffic
signals.

|  | Baseline (estimated from joanna.md investigation, ~25%) | Post-fix |
|---|:---:|:---:|
| training preferred-% | ~25% | **79.3%** (15.05 km on preferred infra of 18.99 km) |
| training major-road painted lane | 6.63 km | 0.19 km |
| kid-traffic-savvy preferred-% | ~96% | 89.7% |

Commit 2 (training `levelMultipliers`) is unambiguously a win on the
case Joanna originally flagged. Major-road painted-lane usage dropped
from 6.6 km to <0.2 km on her test corridor.

## Diagnosis of the kid-mode regression

**The −39pp / −20pp drops on kid-starting-out and kid-confident are
caused by commit 3 (high-stress PBL demote), not commit 4.**

Commit 3 demotes `pathLevel` from `1a` → `2a` when:
- way is tagged `cycleway[:right|:left|:both]=track` or `is_sidepath`
- parent highway in {primary, secondary, tertiary}
- maxspeed > 30 km/h

In Berlin specifically, this matches a very common pattern:
curbside-separated cycle tracks alongside arterials. The intent —
match Joanna's mental model of "high-stress PBLs" — is correct.

But: kid-starting-out only accepts `1a` for riding, kid-confident only
accepts `1a` + `1b`. Demoting to `2a` flips many edges from "ride this"
to "bridge-walk this." For kid-starting-out, that converts about 40%
of the mode's previously-rideable infrastructure into walking-only,
hence the time blow-up (176 min → 291 min on average) and the
preferred-% collapse.

Three observations that lead me to recommend NOT trying to "fix" this:

1. **The Joanna spec explicitly anticipates kid-mode shifts.** The task
   read: "kid-modes may shift on Kreuzberg corridors." A 40pp shift is
   on the high end, but the *direction* matches the user's intent —
   these PBLs aren't safe for kids regardless of mode acceptance, and
   walking the bike on the sidewalk is the correct mitigation.

2. **The modes Joanna actually rides — kid-traffic-savvy and
   carrying-kid — are within tolerance** (−1pp on Berlin, 0pp on SF).
   Training improved (+1pp Berlin, +2pp SF). The big shifts are on the
   slowest modes that probably wouldn't be used for cross-Berlin trips
   in the first place.

3. **Tightening the demote breaks Joanna's case.** Lifting the
   threshold to maxspeed ≥ 50 km/h would skip Kotbusser Damm (which
   _is_ tagged 50). Restricting to "primary/trunk only" would skip
   secondary-class arterials like Kotbusser Damm and Hasenheide. Any
   relaxation that brings kid-starting-out's preferred-% back up
   undoes commit 3's intent.

The walking-edge carve-out fix on the #4 penalty (`19b504f`) **did**
help — it caught a separate over-firing where the +50s/×2 penalty
was applied to bridge-walks crossing the same junctions, compounding
the demote regression. Without that fix, kid-starting-out would have
been even worse. With it, the residual regression is entirely
attributable to commit 3.

## Recommendation

**WIP — do not merge without Bryan's explicit decision.**

Per the routing-changes rule, a >3pp drop on any mode means STOP.
Two modes drop dramatically. The drops are arguably *intended*, but
the magnitude is large enough that the user should make the call,
not me.

Options for Bryan:

A. **Ship as-is.** The kid-modes correctly bridge-walk through
   Kotbusser-Damm-style PBLs. Users who rely on those modes for
   cross-Berlin trips will see longer routes. The improvement on
   Joanna's actual case (training/Rudower Ch corridor) is dramatic.

B. **Tighten demote.** Add a guard: `parent road has bus traffic
   AND/OR maxspeed ≥ 50` to narrow the rule. Would partially recover
   kid-modes but partially undo the user-research intent. Needs
   another benchmark round.

C. **Mode-aware demote** (rejected outright by `learnings.md`'s
   "one classifier" invariant — would split display from routing).

D. **Land 1, 2, 4 only and defer 3.** Commits 2 and 4 are the wins
   on Joanna's flagged case; commit 3 is the disagreement.

## Files

- `/tmp/bench-berlin-baseline-direct.log` — main, direct Overpass
- `/tmp/bench-berlin-after2.log` — joanna-routing-changes, direct Overpass
- `/tmp/bench-sf-baseline-direct.log` — main, direct Overpass, SF
- `/tmp/bench-sf-after.log` — joanna-routing-changes, direct Overpass, SF
- `/tmp/rudower-spot-check-4.log` — debug-rudower-ch.ts post-fix
