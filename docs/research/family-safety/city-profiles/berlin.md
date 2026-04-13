# Berlin

**Archetype:** Berlin (protected infra exists but network has gaps; surface penalties matter)
**Mode share:** ~18%
**Most surprising finding:** ADFC statistic — 88% of Berlin cyclists feel so unsafe they would only let their children cycle alone "with a guilty conscience."

## Per-segment quality — OK to good

Bimodal. Fahrradstraßen and the new wave of curb-protected lanes on Hasenheide, Holzmarktstraße, Sonnenallee, and Steglitzer Damm are legitimately good ("stay clear of the door zone" is the parent-praise phrase). Elsewhere, painted lanes in the door zone remain common, and cobblestones penalize kid bikes hard.

## Network continuity — Gaps

As Bicycle Dutch put it: "on a four-lane busy road with a 50 km/h speed limit, there would be no separate cycleways, and then on a much calmer minor street… there was." This is the defining Berlin failure mode.

## What "protected" means locally

Curb-separated, or Fahrradstraße (legally bike-priority, max 30 km/h, no through motor traffic). **Painted lanes — especially those in the door zone — are NOT trusted**, and the city swapped the parking and bike lane on Kantstraße after a fire-access dispute.

## Beloved family routes

- **Mauerweg** (former Berlin Wall trail, ~160 km car-free ring)
- Fahrradstraßen in Kreuzberg and Prenzlauer Berg
- 30 km/h Spielstraßen where kindergartners practice on Laufräder

Note: Berlin law lets kids up to 8 ride on the sidewalk, accompanied by a parent — a quirk parents lean on heavily.

## Avoided corridors

- **Kantstraße** (formerly a door-zone paint lane, now swapped)
- Schönhauser Allee
- Any 50 km/h stroad with painted lanes only
- Pop-up Radwege that were poorly built

## Vocabulary

*Fahrradstraße, Radweg* (sidewalk-level path) vs *Radstreifen* (painted street lane), *Kindersitz, Laufrad, Spielstraße, Pop-up-Radweg*

## Routing-model implications

- `bicycle_road=yes` → LTS-1 override
- `surface=sett` or `surface=cobblestone` → heavy demote (child-specific penalty, not adult)
- `cycleway=lane` alone is NOT trusted as protection in Berlin — must have `cycleway=track` or `bicycle_road=yes`
- Network continuity index will be meaningfully below Amsterdam/Copenhagen

## Sources

- [Bicycle Dutch — Cycling in Berlin, a trip down memory lane](https://bicycledutch.wordpress.com/2023/07/19/cycling-in-berlin-a-trip-down-memory-lane/)
- [The Berliner — On the bike path to hell](https://www.the-berliner.com/berlin/on-the-bike-path-to-hell/)
- [Berliner Zeitung — The worst places to bike in Berlin](https://www.berliner-zeitung.de/en/the-worst-places-to-bike-in-berlin-li.165906)
- [Berlin.de — Kantstraße bike path: lanes are being swapped](https://www.berlin.de/en/news/9247875-5559700-bike-path-in-kantstrasse-lanes-are-being.en.html)
- [All About Berlin — Bicycle in Berlin](https://allaboutberlin.com/guides/bicycle-in-berlin)
