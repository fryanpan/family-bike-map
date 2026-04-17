# Chunk D · Personal preference layer (Layer 3)

## Goal

Different riders have different tolerances within the same travel mode.
Joanna tolerates cobblestones fine on her road bike; Bryan hates them
at speed. Both ride "training" mode. The mode encodes rider *role* —
we need a layer that encodes rider *taste*.

Success: Joanna can write "I don't mind cobblestones" in plain
English, save it as her profile, and the router treats cobblestones as
ride-at-normal-speed instead of rough-surface for her. Bryan keeps the
default.

## Non-goals

- Not replacing the mode picker. Modes define who you're riding with
  (kid-starting-out vs carrying-kid). Preferences define how *you*
  feel about edge cases within that mode.
- Not multi-user per device (yet) — one "me" profile per device, plus
  the built-in defaults.
- No cloud sync. Local only.

## Current architecture hook

The three-layer plan names this as **Layer 3 · Family preferences**
but leaves it abstract. `docs/product/plans/2026-04-13-three-layer-
scoring-plan.md` says it's the place where rider taste overrides the
otherwise city-and-mode-neutral decision.

## Design

### Data model

```ts
// src/data/preferences.ts
interface RiderPreference {
  name: string                       // "Bryan", "Joanna"
  rawText: string                    // original English preference
  adjustments: PreferenceAdjustment[]
  createdAt: number
  updatedAt: number
}

type PreferenceAdjustment =
  | { kind: 'surface'; surface: string; tolerance: 'ok' | 'rough' | 'reject' }
  | { kind: 'path-type'; item: string; pref: 'prefer' | 'neutral' | 'avoid' }
  | { kind: 'speed-cap'; mode: RideMode; maxSpeedKmh: number }
```

One `RiderPreference` is active at a time (like mode). Stored in
`localStorage.bike-route-preferences` as `RiderPreference[]` plus an
`activePreferenceId`.

### Translation from English to adjustments

Two paths:

**Path 1 · Rule-based parser** (MVP, ships first)

A deterministic parser that handles a small canon of phrasings:
- "cobblestones are fine" / "I don't mind cobbles" → surface=cobblestone, tolerance=ok
- "hate paving stones" / "avoid paving stones" → surface=paving_stones, tolerance=rough
- "prefer Fahrradstraße / cycleway / …" → path-type=*, pref=prefer
- "don't route me through parks" → path-type=Shared foot path, pref=avoid
- "faster is fine" / "no slowing for X" → speed-cap override

Unknown phrases go into a **"not yet understood"** list shown to the
user with a "rephrase or contact us" prompt. Users see what was
parsed in plain text so they can trust or edit.

**Path 2 · LLM translation** (future, post-launch)

Call a small LLM with a schema-constrained output to turn freeform
English into adjustments. Gated on a setting; defaults off. Stored
prompt + response in IndexedDB for cache + debugability.

Ship Path 1 first. Path 2 lives as a feature-flag in the same module
once the type contract is stable.

### Apply point in the three-layer chain

```
OSM tags
  → classifyEdge                                        (Layer 1)
  → applyRegionOverlay                                  (Layer 2)
  → applyPreferenceAdjustments  ← NEW, pref-driven      (Layer 3a)
  → applyModeRule                                       (Layer 1.5 / 3b)
```

Layer 3 runs BEFORE the mode rule so preference can flip e.g. "rough"
→ "ok" before the mode rule decides whether the edge is ridable.

### UX

- New quick-option in `?admin` as initial access: **Preferences** tab
  lets Bryan/Joanna save/activate/edit preferences.
- Front-end entry point: a "🧑 Me" chip or button near the mode picker
  (small, unobtrusive) that shows active preference name and opens a
  modal.
- Modal: single textarea for English preferences. Below it, a
  parsed-preview (what the parser understood). Save button.
- "Active preference" shows in the quick-options list alongside Home
  and School.

### Shareability

Preferences are per-device, but each has a shareable URL:
`?rider=joanna-2026-04-18` reads preference from URL → offers to save
locally. Lets families share by link.

## Work items

1. **Types + storage.** `src/data/preferences.ts` with the types,
   load/save/serialize helpers, key validation.
2. **Rule-based English parser.** `src/data/preferenceParser.ts` with
   a canon of ~15 English phrasings + test file with examples.
3. **`applyPreferenceAdjustments` function.** Pure; inserts between
   region overlay and mode rule in `clientRouter.ts`.
4. **Minimal modal UI.** Small, reachable from an admin-like entry
   point first. Polish later if it stays.
5. **Tests.** Parser round-trips for all canon phrases. Adjustment
   composition (preference + mode + region profile order).
6. **Benchmark sanity.** Run with "cobblestones fine" preference
   active — rough-surface segments now pass; routes through historic
   districts shorter.
7. **URL sharing.** Query param `?rider=` reads a preference blob,
   prompts to save.

## Risks

- **Parser brittleness.** Users will try phrasings we don't support.
  The "not yet understood" bucket is load-bearing. UX must make it
  obvious when something wasn't parsed, not silently do nothing.
- **Interaction with region profile.** Landwehrkanal-promoted edges
  shouldn't be flipped back down by a "prefer roads" preference.
  Order matters: region profile runs first; preference runs second;
  preference rules should be additive (loosen) not contradictory
  (invert). Build the composition to make inversions explicit.
- **Preference bloat** — a long-time user accumulates dozens of
  niche tweaks. Cap at 20 per preference; offer an "audit my
  preferences" view in admin.

## Exit criteria

- [ ] One preference can be typed in English, saved, and activated
- [ ] Active preference modifies routing in a visible way
  (benchmark shows cobblestone-fine preference opens up historic
  district routes)
- [ ] Preferences persist across reloads, survive mode switches
- [ ] Unknown phrases are surfaced, not silently dropped
- [ ] `?rider=` URL param works for sharing
- [ ] Docs: `docs/product/decisions-preferences.md` captures the
  parser-first, LLM-later decision

## Open questions

1. **Auto-detect who's riding?** Probably no — explicit switch is more
   trustworthy. Users can mistap.
2. **Should preferences affect display overlay colors too?** Yes,
   ideally — if Joanna doesn't mind cobbles, Mauerweg cobbles should
   show green on her device. Costs extra plumbing; defer to after
   routing lands.
3. **Family vs individual.** If Bryan is riding with Joanna, whose
   preference wins? For now: the ACTIVE preference wins (Bryan
   switches to "Bryan" when he's riding; Joanna switches to
   "Joanna"). Family routing (group-minimum within preferences) is a
   future chunk.
