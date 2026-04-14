# Carrying kids by bike — hardware landscape

Market research backing the single "Carrying kid" mode in family-bike-map. Documents why we collapse four hardware variants (child seat, longtail cargo, bucket cargo, trailer) into one routing mode, and what refinements Layer 3 prose needs to capture when the differences actually matter.

## The four variants

| Variant | Typical brands | Where common | Adult pilots? | Vehicle width | Turning radius | Surface sensitivity |
|---|---|---|---|---|---|---|
| **Child seat** (rear or front) | Yepp Maxi, Thule Yepp, Hamax Caress, Bobike | Global baseline — cheapest option | Yes | Standard bike | Standard | Standard (slight CoG shift) |
| **Longtail cargo** | Tern GSD, Yuba Spicy Curry / Kombi, Xtracycle, Radwagon | US dominant, growing in Europe | Yes | Standard | Slightly wider | Moderate |
| **Front-load bucket** (bakfiets) | Urban Arrow, Babboe, Christiania, Nihola, Larry vs Harry Bullitt, Riese & Müller Load | NL/DK dominant, widespread in Germany | Yes | **Wide** (~80–90 cm box) | **Large** | High (kid is unbuckled and feels every bump) |
| **Trailer** | Burley, Thule Chariot Cross, Croozer | Global occasional / second-bike | Yes (tows) | Wide at hitch (~75–85 cm) | Large | **Very high** (rigid low frame, hard suspension) |

### Additional carrying patterns worth naming

- **Sannin-nori mamachari** (Japan) — legally-specced three-person bike with both a front and rear child seat. Always paired with e-assist because of hills. Dominant in Tokyo and most Japanese cities. ([Nippon.com — Mamachari](https://www.nippon.com/en/features/jg00091/), [Savvy Tokyo — cycling with kids](https://savvytokyo.com/a-guide-to-cycling-in-tokyo-with-kids/))
- **Copenhagen Christiania bike** — the canonical bucket cargo bike, steel frame, front box, three wheels. The parent complaint is *handling* (tight turns, cargo weight shift), not routing. ([Medium — city biking with two small children](https://medium.com/@alkidel/city-biking-with-two-small-children-cf06e86ab6be))
- **Dutch bakfiets** — similar front-load, lighter frame, usually two-wheel. Tested to EN 17860-2/-5 cargo-bike standards in serious models. ([Aitour — how to choose a safe cargo bike in Denmark](https://www.aitourebikes.com/blogs/aitour-blogs/how-to-choose-a-safe-and-reliable-cargo-bike-in-denmark))

## Regional prevalence (from parent-voice sources)

**Copenhagen / Amsterdam** — bucket cargo dominates the family-biking look. "Almost every second family bike is a bakfiets or Christiania." E-assist now standard on new purchases, though non-assist remains common on older ones. Copenhagen parents' biggest complaint is their own *handling* of a loaded Christiania ("the ride is bumpy for the ones in the cargo and my husband did not feel at ease with turns, especially turning left" — [Medium](https://medium.com/@alkidel/city-biking-with-two-small-children-cf06e86ab6be)). Implication: the infrastructure accepts the bike; the operator is the limit.

**Berlin** — mixed. Trailers and bucket cargo bikes coexist with front/rear child seats. The Radstaltung economy is fragmented; no single dominant form. Sidewalk-cycling for kids ≤8 is legal and leaned on, which reduces parental cargo-bike reliance vs. Copenhagen. ([All About Berlin — bicycle guide](https://allaboutberlin.com/guides/bicycle-in-berlin))

**San Francisco** — overwhelmingly **e-assist longtail cargo**. "San Francisco is the kind of city that is made for assisted bikes," Dorie Apollonio (Rosa Parks Elementary parent) told Streetsblog. Hills make non-assist impractical; longtails dominate because Valencia-style protected lanes are narrow enough that a bakfiets would struggle, and because US family-biking culture grew up post-longtail. ([Streetsblog SF — cargo electric-assist bikes gain traction](https://sf.streetsblog.org/2014/04/25/cargo-electric-assist-bikes-gain-traction-among-sf-families))

**Tokyo** — **sannin-nori mamachari with e-assist, period.** No other form is common among Tokyo parents with two kids. Yamaha PAS Babby, Panasonic Gyutto, and Bridgestone Bikke are the three dominant models. The e-assist is *load-bearing* — without it, Tokyo hills collapse the system. ([Savvy Tokyo](https://savvytokyo.com/a-guide-to-cycling-in-tokyo-with-kids/), [Nippon.com](https://www.nippon.com/en/features/jg00091/))

**Netherlands (Amsterdam, Utrecht)** — bakfiets dominant, e-assist widespread but non-assist still viable because the country is flat. Front child seats are culturally iconic (Dutch kids start as passengers at ~6 months).

**Mexico City** — ECOBICI is adult-only and no helmets; families biking with kids use their own bikes. Child seats and trailers present but rare outside Reforma/Condesa/Roma. Bucket cargo is unusual. ([ECOBICI guide](https://www.theunconventionalroute.com/ecobici-mexico-city-guide/))

**Montreal** — mixed North American pattern. Longtail and bakfiets both visible. Winter adds a distinctive constraint: trailers become snow-sleds in winter (real usage, not a joke). ([2727 Coworking — Winter cycling in Montreal](https://2727coworking.com/articles/winter-cycling-montreal-infrastructure))

## What differs for routing — and what doesn't

### Differences that matter

1. **Minimum passable width.** Bucket cargo bikes (~80–90 cm wide at the box) and trailers (~75–85 cm at the hitch) **cannot fit through tight filtered-permeability bollards**, chicanes, and kissing gates that exclude cars. A Berlin or London filtered neighborhood that sends you through a 70 cm gap is impassable on a bakfiets. This is a real routing constraint in cities that use filtered permeability heavily.

2. **Surface sensitivity (kid-comfort dimension).** Trailer > bucket cargo > longtail > child seat. A trailer over sett cobblestones is genuinely painful for the passenger; a rear child seat over the same surface is merely annoying. Paving stones are the Berlin edge case — fine on a stable longtail or seat, rattly on a trailer.

3. **Turning radius.** Only a problem at acute-angle junctions and when reversing. Doesn't show up in normal routing because the router doesn't currently emit acute-angle corners. Future concern, not current.

4. **Gradient tolerance on non-assist.** Trailer drag + bucket weight make unassisted hill climbing hard. E-assist removes the difference. Matters in SF, CDMX, Lisbon, Barcelona's upper Collserola — not in Berlin or Amsterdam.

### Differences that don't matter (for routing)

- **Load capacity.** Trailer and bakfiets both carry 2 kids; longtail carries 2 kids + cargo. Irrelevant to edge classification.
- **Handling in tight spaces at low speed.** A Christiania is wobbly at walking pace; a longtail is easy. Matters for the rider, not the route.
- **Theft resistance.** Bakfiets are heavy and often ground-anchored; longtails are easier to steal. Relevant to end-of-trip security, not routing.
- **Stability in crosswinds.** Bucket cargo catches wind; longtails don't. Weather-dependent, not in v1.
- **Rain cover quality.** Weather, not routing.

## Why we collapse into one "Carrying kid" mode

Four top-level modes for one logical category — "adult piloting with kid on board" — is more UI surface than useful differentiation. The routing-relevant differences (width, surface, gradient) are **bounded, expressible in prose, and not universally activated**. Most carrying-kid routes don't hit a narrow bollard; most surfaces are fine for any variant; most cities don't have routing-breaking gradients.

**One mode, Layer 3 prose refines.** Example prose the family adds to their city description:

> "We use a front-load Urban Arrow, so we need at least 1 m clearance at bollards. No e-assist, so we can't do sustained climbs over 4%."

Opus compiles that into a `minWidthM: 1.0` and `gradientCapPct: 4` modifier. The router applies it on top of the base "Carrying kid" mode. No second top-level picker needed.

**Optional e-assist toggle.** The one refinement that might merit a binary checkbox (not a separate mode) is "I have an e-bike." It changes acceptable gradient enough in SF, CDMX, Lisbon, and the hillier parts of Berlin that a one-click answer is cleaner than prose. Status: deferred until we have a user complaint.

## When to split into multiple carrying modes

Promote to two or more top-level modes only if telemetry or user feedback shows:

- A meaningful number of routes fail because of bollard width (bakfiets complaint)
- Parents regularly switch modes to compare routes for the same trip (implying the current single mode mis-serves both cases)
- A city archetype emerges where the hardware is so uniform it deserves its own preset (Tokyo sannin-nori, maybe)

Until then: one mode, prose refinement, simple picker.

## Sources

- [Streetsblog SF — Cargo electric-assist bikes gain traction among SF families (2014)](https://sf.streetsblog.org/2014/04/25/cargo-electric-assist-bikes-gain-traction-among-sf-families)
- [Medium — City biking with two small children (Copenhagen)](https://medium.com/@alkidel/city-biking-with-two-small-children-cf06e86ab6be)
- [Savvy Tokyo — A guide to cycling in Tokyo with kids](https://savvytokyo.com/a-guide-to-cycling-in-tokyo-with-kids/)
- [Nippon.com — Mamachari features](https://www.nippon.com/en/features/jg00091/)
- [Aitour — How to choose a safe cargo bike in Denmark](https://www.aitourebikes.com/blogs/aitour-blogs/how-to-choose-a-safe-and-reliable-cargo-bike-in-denmark)
- [All About Berlin — Bicycle in Berlin](https://allaboutberlin.com/guides/bicycle-in-berlin)
- [The Unconventional Route — ECOBICI Mexico City guide](https://www.theunconventionalroute.com/ecobici-mexico-city-guide/)
- [2727 Coworking — Winter cycling in Montreal infrastructure](https://2727coworking.com/articles/winter-cycling-montreal-infrastructure)
