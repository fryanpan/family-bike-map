# Safety in Numbers

Research behind the city-level mode-share multiplier used in Layer 2 of the scoring model.

## TL;DR

As cycling mode share rises, per-cyclist crash risk falls nonlinearly. The meta-analytic pooled exponent is ~**0.43** (Elvik & Goel 2019): if cycling doubles, injuries rise only ~35%, so per-cyclist risk drops ~32%. About half the effect is real driver adaptation; the other half is infrastructure confound. For family-bike-map, we apply a **damped** city-level multiplier:

```
risk_multiplier(m) = (m_ref / m) ^ 0.25
```

with `m_ref = 0.28` (Copenhagen). This is applied **at the city level, not per edge**, because safety-in-numbers is a macro effect that does not meaningfully vary between individual streets.

## Jacobsen 2003 — the original claim

[**Safety in numbers: more walkers and bicyclists, safer walking and bicycling**, Injury Prevention 2003 (PDF)](https://www.littlerock.gov/media/2355/jacobsen_2003_safety_in_numbers.pdf) · [PubMed](https://pubmed.ncbi.nlm.nih.gov/12966006/)

Jacobsen analyzed five datasets (California cities, Danish towns, European countries, UK time series, Dutch time series). He found injuries to cyclists/pedestrians from motor vehicles scale sub-linearly with exposure. Fitted power law approximately:

```
E ~ V^0.4
```

where E is injuries and V is cyclist volume. Doubling volume raises total injuries ~32%, so per-cyclist risk drops ~34%. Jacobsen also reported motorist–cyclist collisions at intersections rising with only the 0.4 power of cyclist volume.

## Replications, meta-analyses, and critiques

- [**Elvik 2009** (PDF)](https://www.cycle-helmets.com/elvik.pdf) — broadly confirmed the non-linear pattern but warned it is not a causal law.
- [**Elvik & Bjørnskau 2017** — systematic review & meta-analysis (ScienceDirect)](https://www.sciencedirect.com/science/article/abs/pii/S0925753515001812) — consistent SiN with pooled exponents across studies.
- [**Elvik & Goel 2019** — updated meta-analysis (AAP)](https://www.sciencedirect.com/science/article/pii/S0001457519303641) — random-effects pooled regression coefficients: **0.43 for cyclist volume**, 0.51 for pedestrian, 0.50 for motor-vehicle volume. ~0.4 is the right central estimate for cycling.
- [**Bhatia & Wier 2011** — SiN re-examined (AAP)](https://www.sciencedirect.com/science/article/abs/pii/S0001457510002484) — critique: cross-sectional correlation is not proof of behavioral mechanism; confounding by infrastructure, land use, and self-selection is plausible.
- [**Fyhri & Bjørnskau 2013** — Oslo seasonal study (ResearchGate)](https://www.researchgate.net/publication/271131110_Safety_in_Numbers_-Uncovering_the_mechanisms_of_interplay_in_urban_transport_with_survey_data) and [Fyhri et al. 2016 seasonal interplay](https://cyberleninka.org/article/n/1417951) — video + surveys found a short-term, within-season SiN: as cyclist counts rose April → September, individual near-miss rates fell, partially masked by influx of inexperienced riders. Strongest evidence that the mechanism is real driver adaptation, not just infrastructure confound.

## Mechanism

Current best evidence: a mix.

- **Driver adaptation is real** — Fyhri's Oslo video data and [Rubie et al. 2020 on driver behavioral response (ScienceDirect)](https://www.sciencedirect.com/science/article/abs/pii/S0022437520300451) show motorists in higher-volume environments anticipate cyclists better.
- **Infrastructure confound is also real** — [Schepers et al., *The Dutch road to a high level of cycling safety* (PDF)](https://eprints.qut.edu.au/120431/1/SchepersetalTheDutchroadtoahighlevelofcyclingsafety.pdf) show Dutch low cyclist risk is largely infrastructure-mediated.
- **Self-selection** matters at low mode share: when only confident riders cycle, the cohort is less vulnerable.

Consensus: SiN is causal but **smaller than the raw 0.4 exponent suggests** once infrastructure is controlled for — perhaps half the effect is behavioral.

## Mode-share thresholds

No clean breakpoint in the literature; the power law is continuous. Natural-experiment anchors:

- **Seville**: mode share 0.5% → 5.6% (2006–2011) after a 120 km connected network; **KSI per million trips fell ~90%** ([Marqués et al. 2017, AAP](https://www.sciencedirect.com/science/article/abs/pii/S0001457517301021)).
- **Oslo seasonal 2–3× volume swings** produce measurable within-season risk drops per cyclist (Fyhri).

Practitioners treat **~5% mode share** as the point where driver expectations noticeably shift; below ~2% the effect is swamped by noise and self-selection.

## Practical formula for family-bike-map

Use city cycling mode share `m` (fraction of trips) as a **multiplicative risk modifier** on baseline LTS, applied *after* infrastructure scoring so we don't double-count. Derived form:

```
risk_multiplier(m) = (m_ref / m) ^ α
```

- `m_ref = 0.28` (Copenhagen)
- `α = 0.25` — damped from Elvik & Goel's 0.43 because our infra scorer already rewards protected infrastructure. Using the full 0.43 double-counts the infrastructure-confound portion of SiN.

### Reference table (α = 0.25)

| City | Mode share | Multiplier |
|---|---|---|
| Amsterdam | 0.35 | 0.95 |
| Copenhagen | 0.28 | 1.00 |
| Potsdam | 0.20 | 1.09 |
| Berlin | 0.18 | 1.11 |
| Tokyo | 0.14 | 1.19 |
| Seville | 0.06 | 1.48 |
| Paris | 0.05 | 1.54 |
| Bogotá | 0.05 | 1.54 |
| London | 0.04 | 1.62 |
| Taipei | 0.04 | 1.62 |
| Barcelona | 0.03 | 1.73 |
| Montreal | 0.03 | 1.73 |
| San Francisco | 0.025 | 1.82 |
| Mexico City | 0.02 | 1.93 |
| NYC | 0.013 | 2.17 |

Mode shares are approximate 2020s figures; per-city profiles cite sources.

### Scope

- **City-level only.** SiN is a macro effect; do not vary between edges of the same city.
- **Damping.** If we later strengthen the infra scorer, we may need to damp α further. If we weaken it, we may move toward 0.30–0.35.
- **Not a license to route through danger.** The multiplier is a tiebreaker between otherwise-comparable routes; it never overrides LTS 4 exclusions.

No published framework formally combines LTS with mode-share exposure; the closest is the [**CWANZ safety factsheet** (PDF)](https://www.cwanz.com.au/wp-content/uploads/2022/04/CWANZ-SAFETY-FACTSHEET-WITH-REFERENCES.pdf) which cites SiN alongside infrastructure. We are on novel but defensible ground.
