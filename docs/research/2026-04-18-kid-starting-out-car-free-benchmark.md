# Routing Benchmark — kid-starting-out now car-free only

**Date:** 2026-04-18
**Change:** kid-starting-out no longer accepts bikePriority (Fahrradstraßen,
living streets, SF Slow Streets). Only physically car-free infrastructure.
Bridge-walk fallback continues to keep the graph connected.

## Per-mode summary (22 Berlin routes)

| Mode | Routes found | Avg preferred | Avg walk | Δ preferred | Δ walk |
|---|:---:|:---:|:---:|:---:|:---:|
| **kid-starting-out** | **20/22** | **47%** | **50%** | **−5pp** | **+11pp** |
| kid-confident | 20/22 | 58% | 9% | 0 | 0 |
| kid-traffic-savvy | 20/22 | 88% | 3% | 0 | 0 |
| carrying-kid | 20/22 | 89% | 6% | 0 | 0 |
| training | 20/22 | 89% | 6% | 0 | 0 |

## Interpretation

The kid-starting-out preferred % drops from 52% → 47% and walking % jumps
39% → 50%. Both changes are **intended**:

- Fahrradstraßen previously rode at normal speed and counted as preferred.
  They are now bridge-walked (still in the graph, but at walking speed,
  and not counted toward preferred %).
- Living streets and SF-style Slow Streets follow the same pattern.
- Truly car-free paths (cycleways, park paths, curb-separated tracks,
  pedestrianised zones) still ride at normal speed and count as preferred.

No other mode is affected. Kid-confident still rides Fahrradstraßen at
full speed (ridingSpeedKmh unchanged).

## Why this is correct behavior

A kid who is just learning to ride can't be trusted to handle even an
occasional car on a Fahrradstraße — the car is legal there, it just
tends to yield. "Tends to yield" is not a safety margin a parent will
accept for a 3-5 year old. The previous behavior treated Fahrradstraßen
as kid-safe; the new behavior treats them as "walk the bike here" —
still usable, just honest about the risk level.

The connectivity invariant holds: 20/22 routes still complete (the 2
failures are outside the Berlin tile bbox, as before).

## Graph size delta

| Mode | Nodes before | Edges before | Nodes after | Edges after |
|---|:---:|:---:|:---:|:---:|
| kid-starting-out | 647K | 1.24M | 647K | 1.24M |

Identical. No edges were removed — previously-rideable Fahrradstraße
edges just switched from `isWalking: false` → `isWalking: true`.
