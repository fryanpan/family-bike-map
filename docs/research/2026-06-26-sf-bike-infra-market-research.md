# SF Bike Infrastructure — Market Research

**What do people think of different bike-infrastructure types in San Francisco, and what does it imply for the app's routing priorities?**

Date: 2026-06-26 · Scope: San Francisco (the app's second launch city) · Method: four parallel source sweeps (Reddit/community, Strava/usage, surveys/academic, news/advocacy), every claim source-linked. Complements the existing infrastructure-fact profile in [`family-safety/city-profiles/san-francisco.md`](family-safety/city-profiles/san-francisco.md) — this doc is about *perception and revealed behavior*, not the network's physical facts.

---

## TL;DR — the five things that matter for routing

1. **Car-free wins on every axis.** It's the most-loved infra type in stated sentiment *and* the most-used in revealed preference. The busiest bike counter in SF is a car-free path (Marina/Baker, >1M/yr); JFK Drive going car-free drove **+300% bikes** including a surge in kids; and in the cleanest natural experiment available — the Embarcadero, where a protected lane was built next to an existing shared promenade — **94% of riders chose the dedicated lane**. This directly validates the **car-free cost bonus we shipped today**.
2. **"Separated" is not a monolith — geometry and intuitiveness matter.** Valencia's *center-running* "protected" lane lost **−53% ridership** and was torn out by unanimous SFMTA vote, even though it was physically separated. Reward *curbside/parking-protected and car-free*; don't score every exotic "separated" geometry as top-tier.
3. **Paint and plastic posts are distrusted as fake protection.** SF cyclists and advocates actively resent post-and-paint lanes being called "protected," and treat door-zone painted lanes as *worse than nothing*. This reinforces the app's existing `cycleway=lane → reject as protection` rule for SF.
4. **Sharrows are consensus-useless.** Across advocacy, academic (LTS treats them as *no stress reduction*), and even a former CA Bicycle Coalition director who publicly recanted. Route as essentially unprotected.
5. **Hills are a first-order route-choice factor, and families weight separation over "quiet-but-unmarked."** The Wiggle exists purely for grade-avoidance; the SFCTA route-choice model puts a **~$0.61/km** value on having a bike lane and finds steep slopes strongly disfavored (more so for women). Parents allow kids on a multi-use path **88%** of the time vs **32%** on a narrow residential street — corroborating the app's `carFree` vs `bikePriority` split.

---

## Why people sort this way — the "Four Types of Cyclists"

The dominant market-segmentation lens (Geller, Portland 2006; validated by Dill & McNeil). The population splits roughly:

| Type | Share | Rides today? |
|------|-------|--------------|
| Strong & Fearless | <1% | anywhere |
| Enthused & Confident | ~7% | most infra |
| **Interested but Concerned** | **~56–60%** | **only when it feels safe** |
| No Way, No How | ~33% | never |

The majority — "interested but concerned" — "would ride if cars were slower and less frequent, and if there were more quiet streets with few cars and paths without any cars at all." The quantified conversion lever is **physical separation**: 88% of this group say they'd be more likely to ride if a barrier separated them from traffic. A *family* app is built precisely for this segment plus their kids, who are stricter still.

Sources: [Geller, Four Types of Cyclists (Portland)](https://www.portland.gov/sites/default/files/2022/Four%20Types%20of%20Cyclists%20updated%202009.pdf) · [Dill & McNeil, TRR 2013](https://journals.sagepub.com/doi/10.3141/2387-15) · [national replication, TRR 2016](https://journals.sagepub.com/doi/10.3141/2587-11). Caveat: a 2020 reappraisal ([Pearson et al.](https://www.sciencedirect.com/science/article/abs/pii/S0965856420305887)) argues the share is fuzzier than one number implies — use as a heuristic, not a precise market size.

---

## Infrastructure types, ranked by sentiment + evidence

Ordering is consistent across stated sentiment, academic comfort ranking, and revealed use.

### 1. Car-free / park paths — **LOVED (the family gold standard)**
- **Stated:** the clearest positive signal in SF. JFK Promenade "wildly successful… only become more popular" ([Streetsblog SF](https://sf.streetsblog.org/2022/02/14/celebrating-j-f-k-promenade-forever)); Prop J (keep JFK car-free) **passed ~59–63%**, Prop I (cars back) failed ~39% ([Ballotpedia](https://ballotpedia.org/San_Francisco,_California,_Proposition_I,_Allow_Private_Vehicles_on_JFK_Drive_and_Connector_Streets_in_Golden_Gate_Park_Initiative_(November_2022))). Sunset Dunes (former Great Highway) drew **1.7M+ visits** in year one ([NBC Bay Area](https://www.nbcbayarea.com/news/local/debate-controversial-san-francisco-park/4075154/)).
- **Revealed:** busiest counter citywide is the car-free Marina/Baker path (>1M in 2019, [SFMTA](https://www.sfmta.com/blog/biking-numbers-san-franciscos-2019-biking-statistics)); Embarcadero experiment — **94%** chose the dedicated protected lane over the shared promenade when both existed ([SFMTA](https://www.sfmta.com/blog/good-times-are-rolling-embarcadero-bikeway)); JFK car-free **+300% bikes** incl. children ([Kid Safe SF](https://kidsafesf.com/jfk), advocacy figure).
- **Academic:** parents allow kids on multi-use paths **88%** of the time — highest of any facility ([Cain et al. 2019](https://www.sciencedirect.com/science/article/abs/pii/S136984781830740X)).
- **Caveat — crowding:** the Panhandle path is loved but congested, with bike-vs-pedestrian and e-bike-speed conflict ([Streetsblog SF](https://sf.streetsblog.org/2017/01/09/survey-war-over-panhandle-protected-bike-lanes)). Unmodeled by the app today.

### 2. Slow Streets / bike boulevards / the Wiggle — **LOVED (low-stress, family-friendly)**
- **86%** of residents support the Slow Streets program and want it permanent ([SFMTA](https://www.sfmta.com/blog/residents-overwhelmingly-support-slow-streets)); the board made a slate permanent Dec 2022 (Page, Sanchez, Shotwell, Lake, Clay, Cabrillo, …, [SFMTA program page](https://www.sfmta.com/projects/slow-streets-program)).
- **Revealed:** Slow Lake Street **+65% bikes** on weekdays after conversion ([Slow Lake FAQ](https://www.slowlakestreet.com/faqs)). The Wiggle is an SF institution valued specifically because it *avoids hills* ([Wikipedia](https://en.wikipedia.org/wiki/The_Wiggle)) — revealed evidence that grade is a top route-choice factor.
- **Contested edge:** Slow Streets are divisive with some drivers (harassment reports both directions, [ABC7](https://abc7news.com/post/san-francisco-divided-slow-streets-program-heres-what/15081951/)); Lake St's permanent status shifted over time — treat individual streets as locally contested, not universally beloved.

### 3. True curb / parking-protected lanes (Class IV done right) — **LOVED when real**
- **96%** of people riding in protected lanes felt safer because of them; **76%** of nearby residents want more; first-year bike traffic **+72%** — from the 5-city federal study that **included SF** ([NITC-RR-583 "Lessons from the Green Lanes," 2014](https://nacto.org/wp-content/uploads/2014_NITC-RR-583_Lessons-from-the-Green-Lanes-Evaluating-Protected-Bike-Lanes-in-the-U.S..pdf)).
- Valencia's *curbside* parking-protected lane (2019) drove **~+50%** ridership vs the prior door-zone stripe ([Streetsblog SF](https://sf.streetsblog.org/2024/01/03/sfmta-data-shows-cyclists-stopped-riding-valencia-because-of-center-running-bike-lane)). SF is now piloting raised, sidewalk-level lanes, covered approvingly.

### ⚠ Special case: Valencia center-running "protected" lane — **CONTROVERSIAL, REMOVED**
Physically separated, but **−53% ridership** (Sept 2023 counts) because it was unintuitive and unsafe to access; SFMTA voted unanimously to remove it (Nov 2024), reverting to curbside ([Streetsblog SF](https://sf.streetsblog.org/2024/11/19/sfmta-approves-removal-of-valencias-center-running-bike-lane), [SF Standard](https://sfstandard.com/2025/02/18/valencia-street-bike-lane-removal/)). **The cautionary tale: separation is necessary, not sufficient.**

### 4. Flex-post / plastic-bollard "protected" lanes — **DISTRUSTED (fake protection)**
A distinct, strong sentiment: "Two-pound plastic posts don't afford a lick of 'protection' against an errant driver" ([Streetsblog SF](https://sf.streetsblog.org/2022/12/01/commentary-hey-sfmta-stop-calling-everything-a-protected-bike-lane)); posts "are there to mark where drivers park," not protect. Local advocates push to stop calling these "protected" at all.

### 5. Painted door-zone bike lanes (Class II) — **DISLIKED / unsafe**
Widely treated as worse than nothing — steer riders into the door zone, become double-parking strips ("a glorified double-parking zone," [SF Standard](https://sfstandard.com/2023/10/16/san-francisco-bike-lanes-illegal-parking/); ["Why Painted Bike Lanes are Immoral"](https://sf.streetsblog.org/2021/10/19/why-painted-bike-lanes-are-immoral-in-one-video)).

### 6. Sharrows (Class III) — **DISMISSED (useless, near no-effect)**
Consensus across advocacy and academia. LTS methodology assigns sharrows **no stress reduction** ([Furth LTS](https://peterfurth.sites.northeastern.edu/level-of-traffic-stress/)); even a former CA Bicycle Coalition director recanted ("I Was Wrong About Sharrows," [Streetsblog SF](https://sf.streetsblog.org/2023/01/24/big-admission-i-was-wrong-about-sharrows)). Women rate them especially low.

---

## Women, families, and children (the most infra-sensitive — and the app's core users)

- **SF women are only ~29% of cyclists** despite ~49% of population; both sexes "use, prefer, and want more protected bike lanes" ([C40 / UC Berkeley SoMa study](https://www.c40.org/women4climate/resources/women-and-biking-a-case-study-on-the-use-of-san-francisco-bike-lanes/)). Women's share is the canonical bike-friendliness indicator.
- **Parents are stricter than the LTS model assumes.** Allowed-for-kids rates: multi-use path **88%**, wide residential **44%**, narrow residential **32%** — and more parents allow a **buffered lane on a busy street** than a narrow quiet street ([Cain et al. 2019](https://www.sciencedirect.com/science/article/abs/pii/S136984781830740X)). Parents weight *separation* over *quiet-but-unmarked*.
- **The SF demand gap:** 80% of San Franciscans want to bike/roll more, but only **23% feel safe enough**, and only **~8%** of the network is high-quality protected/separated ([SFMTA Biking & Rolling Plan](https://www.sfmta.com/blog/adopting-biking-and-rolling-plan-safer-more-connected-san-francisco)). The product is aimed squarely at closing that perceived-safety gap.

---

## What it implies for the app's routing priorities

| Finding | Implication | Status in code |
|---------|-------------|----------------|
| Car-free is most-loved *and* most-used; people detour onto it (Embarcadero 94%, $0.61/km bike-lane value) | A car-free cost discount for family modes is well-validated | ✅ **Shipped today** (`carFreeBonus`, PR #203) — this research is independent confirmation |
| Parents: 88% path vs 32–44% residential | Keep `carFree` strictly above quiet residential (`bikePriority`) for kid modes — don't collapse the two | ✅ Already enforced (`carFree` vs `bikePriority` flags; kid-starting-out rejects 1b) |
| Sharrows = no real comfort gain | Sharrow-only streets should route as ~unprotected | ✅ LTS already treats sharrows as no stress reduction |
| Paint & plastic-post "protected" distrusted | Don't credit `cycleway=lane` / post-and-paint as real protection | ✅ SF profile: `cycleway=lane → reject as protection`. ⚠ **Gap:** OSM rarely distinguishes curb- from post-protected `track`; consider reading `separation`/`cycleway:separation` tags where present |
| Valencia center-running failed despite separation | "Separated" isn't monolithic — reward accessible/intuitive separation | ⚠ Not modeled (OSM can't express "intuitive"); low priority — rare geometry |
| Hills are first-order (the Wiggle; steep slopes strongly disfavored, esp. women) | Ascent cost is load-bearing in SF specifically | ✅ Reinforced today (ascent now applies to walking edges too, PR #203) |
| Slow Streets loved + ridership +65% | Quiet-but-engineered (Slow Street / bike boulevard) is a strong family tier | ✅ Encoded as `bikePriority` (SF Slow Streets = `motor_vehicle=destination`) |
| Park-path crowding (Panhandle) | A greenway-crowding penalty could refine routing, but data is thin | ❌ Not modeled — **candidate future signal**, low confidence |

**Net:** the research independently confirms the app's core routing philosophy and today's car-free + ascent changes. The two genuinely actionable *new* ideas are both low-priority and data-thin: (a) reading OSM `separation`/`cycleway:separation` tags to distinguish real curb protection from post-and-paint where the data exists, and (b) a possible greenway-crowding factor for paths like the Panhandle.

---

## Method, source quality, and honest caveats

- **Reddit could not be accessed** in this environment (WebFetch and WebSearch both block `reddit.com`; no browser session). The "community sentiment" sweep substituted reachable SF-cyclist outlets (Streetsblog SF, The Frisc, SF Standard, SFist, SFMTA, SF Bicycle Coalition). So Reddit-specific tone (e-bike-speed debates, SFMTA venting, NIMBY-vs-cyclist threads) is **not captured** — a follow-up with the Chrome extension or a Reddit API/MCP would fill this.
- **Advocacy skew:** Streetsblog SF / SF Bicycle Coalition / Kid Safe SF are pro-bike outlets, so anti-paint / anti-sharrow sentiment may read stronger than a neutral rider sample. SF Standard / SFist / SFMTA partially balance this.
- **Some headline figures are advocacy-sourced, not primary counters:** JFK "+300%" is from Kid Safe SF; the SFMTA ridership growth figures are self-reported. Directionally corroborated, but not independent.
- **Unverified, flagged:** a "crash-safety perception" numeric ranking (shared-use 1.17 → roads 4.58) matches consensus but its primary source wasn't confirmed — not cited above as fact.
- **Biggest evidence gap:** no rigorous *family/child* revealed-preference route-choice study exists for SF. The SFCTA model is 2011 and skews confident cyclists (it even found traffic volume/speed *per se* non-significant for that cohort — do not over-generalize that to families). The family signal is better evidenced by the Slow Streets / JFK natural experiments than by any single route-choice model.

### Open follow-ups
1. Pull actual Reddit/community-thread sentiment once a Reddit access path exists (Chrome extension / API).
2. Open the NITC-RR-583 and McNeil buffer-types PDFs directly for exact facility-by-facility comfort percentages and gender cross-tabs (they didn't text-extract via WebFetch).
3. Evaluate reading OSM `separation`/`cycleway:separation` tags to grade curb- vs post-protection.
4. Decide whether a greenway-crowding factor (Panhandle) is worth modeling.
