# 2026-06-11 Edge-keyed A* with turn & signal costs — routing benchmark

## Change

Replaced the node-keyed ngraph.path A* with our own **edge-keyed A***
(`src/services/edgeAStar.ts`) so transition costs can depend on approach
direction, per `docs/product/plans/2026-06-11-turn-cost-design.md`:

- **Turn maneuver time** (cost + ETA) by angle class, at junctions or way
  changes; curves inside a way stay free.
- **Turn penalty** (cost only, Valhalla-style) per junction turn ≥60° —
  12 s kid modes / 8 s mid / 5 s training.
- **Signal & stop waits** (cost + ETA): expected averages, 15 s through /
  45 s two-stage left for kid modes; **halved for corridor continuation**
  (straight along the same named street — green-wave reality; added after
  the first run, see below). Signals come from `highway=traffic_signals|stop`
  nodes now fetched in the tile query (cache bumps: worker v4, IDB v4).
- Route card now shows the turn count (`summary.turns`).

## Results (TILE_BUST=v4sig fresh tiles, signals included)

**SF** (baseline = 2026-06-10):

| Mode | found | preferred Δ | walk Δ | avg turns (was*) | avg ETA |
|---|---|---|---|---|---|
| kid-starting-out | 17/17 | 29% (=) | 59% (=) | 8.9 (9.1) | 211 min |
| kid-confident | 17/17 | 39% (=) | 52% (=) | 9.4 (10.4) | 98 min |
| kid-traffic-savvy | 17/17 | 49% (−1pp) | 5% (+2pp) | 8.2 (8.7) | 31 min |
| carrying-kid | 17/17 | 44% (−3pp) | 9% (+3pp) | 9.5 (8.9†) | 29 min |
| training | 17/17 | 41% (=) | 0% (=) | 8.9 (8.9) | 16 min |

\* "was" = same graph, all turn/signal costs zeroed (≡ old A* paths).
† carrying-kid trades turns for signal avoidance; its turn count is flat
while its signalized-crossing count drops.

**Berlin**: all 5 modes **22/22** found; preferred-% within 2pp of the
2026-06-10 baseline (confident 63 vs 65, others ±1). Avg turns 11.5–16.0
now measured. Peak benchmark RSS 1.9 GB (was ~1.7 GB) — edge labels add
transient search memory; acceptable, watch on low-RAM machines.

## The diagnose-and-fix loop (per the routing rule)

First signal-enabled run dropped SF carrying-kid **47→41%** and doubled its
walking share. Diagnosis: the model charged the full expected wait on every
signal pass — including riding **along** an arterial through its own signals,
where real riders mostly roll through on progression. Over-taxing corridor
riding tipped A* toward bridge-walk shortcuts. Fix: straight-through on the
same named street pays half the through-wait. Re-run recovered carrying-kid
to 44% and cut its walking back to 9%. The residual −3pp is intentional
honesty: some green-paint detours genuinely aren't worth their signal waits.

## Interpretation

- **Turn shaping works**: ~1 fewer turn per ~5.5 km route for riding-dominant
  modes (kid-confident 10.4→9.4) at ≤1pp preferred cost. The 12 s penalty is
  deliberately conservative — tune upward against Joanna's known-good routes
  (Gleisdreieck → Mehringdamm) if real rides still feel turn-dense.
- **ETAs are honest now**: SF riding ETAs rose ~3–5 min/route — that's
  10–20 signalized crossings at realistic expected waits, the thing that was
  previously free. kid-mode signal lefts price the two-stage crossing.
- No routes lost anywhere; graph size unchanged (control nodes stamp
  existing graph nodes, they don't add any).
