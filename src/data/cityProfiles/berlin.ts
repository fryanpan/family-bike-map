/**
 * Berlin region profile — Layer 2 overlay rules.
 *
 * Authoritative source: `src/data/cityProfiles/berlin.md`. When the
 * prose there changes, update these rules and re-run the routing
 * benchmark (.claude/rules/routing-changes.md).
 *
 * Ships with three minimum-viable rules; add more as patterns emerge
 * from real use.
 */

import type { RegionProfile } from './overlay'

export const BERLIN_PROFILE: RegionProfile = {
  key: 'berlin',
  displayName: 'Berlin',
  bbox: [52.3382, 13.0884, 52.6755, 13.7611],
  rules: [
    // ── 1. Landwehrkanal + Mauerweg towpaths: the family spine ─────────
    // Citation: berlin.md — "The Mauerweg is the gold standard for
    // family rides." + "Prefer Fahrradstraßen and fully separated bike
    // paths." Towpaths are tagged inconsistently in OSM (sometimes
    // `highway=path`, sometimes `cycleway`, sometimes `footway` with
    // `bicycle=yes`). Normalize them to LTS 1 + car-free regardless
    // of tag.
    {
      kind: 'promote',
      id: 'berlin.landwehrkanal-mauerweg-spine',
      match: {
        nameContains: [
          'Landwehrkanal',
          'Mauerweg',
          'Berliner Mauerweg',
          'Teltowkanal',   // complementary south spine
          'Spreeweg',      // central Spree bank
        ],
      },
      toMinLts: 1,
      setCarFree: true,
    },

    // ── 2. Oranienstraße: bad-driver painted-lane corridor ─────────────
    // Citation: berlin.md — "Don't trust painted bike lanes — they sit
    // in the door zone here." Oranienstraße is the most well-known
    // example: heavy bus traffic, aggressive drivers, door zone,
    // chronically blocked lanes. LTS as-tagged = 2, but parents
    // experience it as 3. Demote so kid modes don't route down it.
    {
      kind: 'demote',
      id: 'berlin.oranienstrasse-painted-lane',
      match: {
        nameContains: ['Oranienstraße', 'Oranienstrasse'],
        tags: { highway: 'tertiary' }, // the arterial stretch, not side streets
      },
      toMaxLts: 3,
      clearBikePriority: true,
    },

    // ── 3. Altstadt cobblestone zone ──────────────────────────────────
    // Citation: berlin.md — "Cobblestones and sett paving are rough on
    // kid bikes, especially when wet; route around the old town."
    // OSM surface tags are unreliable in the Altstadt; assume
    // cobblestone over the whole bounded area (roughly Alexanderplatz
    // → Hackescher Markt → Museumsinsel → Unter den Linden eastern end).
    {
      kind: 'zoneSurface',
      id: 'berlin.altstadt-cobblestone-zone',
      bbox: [52.5160, 13.3950, 52.5260, 13.4200],
      surface: 'cobblestone',
    },
  ],
}
