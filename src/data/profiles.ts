// Default rider profiles — the 5 ride modes shown in the UX picker.
//
// This is the source of truth for mode metadata (label, description, emoji,
// editability).
//
// `costingOptions` retains the Valhalla-shaped fields as historical artefacts
// from when the app routed through Valhalla. The main app does NOT use these
// fields — it reads mode → routing behavior via classify.ts PROFILE_LEGEND and
// the per-mode tables in clientRouter.ts. The fields can be removed once we
// confirm nothing else (e.g. saved-profile JSON shapes in IndexedDB) depends
// on them.
//
// See docs/product/plans/2026-04-13-three-layer-scoring-plan.md for the
// 5-mode rationale and Layer 3 plans.

import type { ProfileMap } from '../utils/types'

export const DEFAULT_PROFILES: ProfileMap = {
  'kid-starting-out': {
    label: 'Kid starting out',
    emoji: '👶',
    description:
      'Kid has some bike control (can stop to avoid danger) but needs fully car-separated pathways. Balance bike to early pedaling. Up to ~3 km. Default mode on first launch.',
    costingOptions: {
      bicycle_type: 'Hybrid',
      cycling_speed: 6,
      use_roads: 0.0,
      avoid_bad_surfaces: 0.5,
      use_hills: 0.1,
      use_ferry: 0.0,
      use_living_streets: 1.0,
    },
    editable: true,
    avoidances: ['cobblestones'],
  },

  'kid-confident': {
    label: 'Kid confident',
    emoji: '🧒',
    description:
      'Kid has good bike control and basic road awareness. Can ride on living streets and Fahrradstraßen with parent alongside. Parent still needs time to correct mistakes. Up to ~8 km.',
    costingOptions: {
      bicycle_type: 'Hybrid',
      cycling_speed: 10,
      use_roads: 0.05,
      avoid_bad_surfaces: 0.4,
      use_hills: 0.2,
      use_ferry: 0.0,
      use_living_streets: 1.0,
    },
    editable: true,
    avoidances: ['cobblestones'],
  },

  'kid-traffic-savvy': {
    label: 'Kid traffic-savvy',
    emoji: '🚸',
    description:
      'Kid handles painted bike lanes, intersections, and traffic signals. Reads traffic and makes split-second decisions. Still a kid — never strong-and-fearless routes. Up to ~15 km.',
    costingOptions: {
      bicycle_type: 'Hybrid',
      cycling_speed: 14,
      use_roads: 0.2,
      avoid_bad_surfaces: 0.4,
      use_hills: 0.3,
      use_ferry: 0.0,
      use_living_streets: 0.9,
    },
    editable: true,
    avoidances: ['cobblestones'],
  },

  'carrying-kid': {
    label: 'Carrying kid',
    emoji: '🚲',
    description:
      'Adult pilots a child seat, trailer, or cargo bike (longtail or front-load). Surface-strict; willing to mix with traffic since adult has full judgment. Up to ~20 km.',
    costingOptions: {
      bicycle_type: 'Hybrid',
      cycling_speed: 22,
      use_roads: 0.15,
      avoid_bad_surfaces: 0.5,
      use_hills: 0.15,
      use_ferry: 0.0,
      use_living_streets: 0.9,
    },
    editable: true,
    avoidances: ['cobblestones'],
  },

  // Bryan's mode. Adult fitness ride. Secondary — Komoot exists for this.
  training: {
    label: 'Fast training',
    emoji: '⚡',
    description:
      '25–35 km/h road training. Smooth asphalt preferred, OK with traffic ≤30 km/h. Avoids tram tracks, narrow unpathable bike paths, and bumpy elevated paths.',
    costingOptions: {
      bicycle_type: 'Road',
      cycling_speed: 30,
      use_roads: 0.7,
      avoid_bad_surfaces: 0.6,
      use_hills: 0.9,
      use_ferry: 0.0,
      use_living_streets: 0.3,
    },
    editable: true,
    avoidances: ['cobblestones'],
  },
}
