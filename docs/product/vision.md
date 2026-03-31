# Product Vision: Bike Route Finder

## Problem Statement

Existing navigation tools (Google Maps, Apple Maps) fail to account for family-specific bike safety preferences. Route quality knowledge exists in people's heads but isn't shareable or discoverable. Families need routes that consider:

- Different riding styles for different riders (kids in trailer vs. solo adult)
- Granular safety preferences beyond basic "bike route" designation
- Time-of-day considerations (quiet side streets acceptable at certain times)
- Route quality feedback that improves recommendations over time

## Target Users

Primary: Families cycling with children in Berlin
Secondary: Individual cyclists with specific safety/comfort preferences

## Core Value Proposition

Enable personalized bike routing based on individual safety preferences and rider capabilities, with routes that improve through community feedback.

## Safety Preference Model

Routes are scored based on family-friendliness:

- **Great:** Fahrradstrasse, fully separated car-free trails (Mauerweg), nature paths
- **Good:** Separated bike lanes on sidewalk
- **OK:** Streets with wide sidewalk + nearby on-street bike lane, low car traffic
- **Acceptable:** Quiet side streets with minimal car traffic (time-of-day dependent)
- **Avoid:** Busy streets without protected infrastructure

## Key Features (Priority Order)

### MVP (Phase 1)
1. **Custom Route Planning**: Route between two points with safety preference weighting
2. **Preference Profiles**: Different profiles for different riding styles (e.g., "with trailer", "solo adult", "confident kid")
3. **OSM-based Data**: Leverage OpenStreetMap bicycle infrastructure tagging
4. **Visual Route Preview**: Show route on map with safety segments color-coded

### Phase 2
1. **Route Tweaking**: Manual route adjustment with feedback ("avoid this segment", "prefer this street")
2. **Feedback System**: Users can rate segments and report changes
3. **Route Sharing**: Save and share custom routes with community
4. **Time-of-Day Routing**: Different routes based on traffic patterns

### Phase 3 (Optional)
1. **Turn-by-Turn Navigation**: On watch or phone
2. **Offline Support**: Download routes for offline use
3. **Community Route Collections**: Curated collections of popular family routes

## Success Metrics

- Routes successfully avoid high-traffic streets when family-safe alternatives exist
- Users successfully complete trips without needing to deviate from planned route
- Route quality improves over time based on feedback
- Routes consider rider-specific preferences accurately

## Constraints

- Use open source tools and data where possible
- Build custom solutions only where existing tools fail
- Prioritize route quality over feature count
- Mobile-first experience for actual navigation

## Research: Existing Tools

### What Exists

**Official Maps:**
- InfraVelo Projektkarte: Official Berlin infrastructure map with Fahrradstraße and protected lanes
- CyclOSM: Bike-focused OSM rendering with surface types
- ADFC paper maps: Color-coded street suitability

**Routing Tools:**
- BBBike: Bike-friendly routing for Berlin
- Komoot: Turn-by-turn with curated routes
- Google/Apple Maps: General routing with "bike" mode

### What's Missing

1. **Granular Preference Weighting**: No tool lets you specify "Fahrradstrasse > separated paths > quiet streets > bus lanes" with custom weightings
2. **Rider-Specific Profiles**: No differentiation between "solo adult" vs. "with kids in trailer"
3. **Gap Filling**: Tools don't help connect gaps in bike network with acceptable alternatives
4. **Time-Aware Routing**: Can't specify "quiet side streets OK before 8am"
5. **Learning from Feedback**: Routes don't improve based on user ratings
6. **Usable UX**: Existing tools (InfraVelo, BBBike) have cluttered, hard-to-read interfaces

### Key Insights from Bryan's Notes

- **InfraVelo**: Good data, but cluttered UX and no routing
- **CyclOSM**: Great data, but essentially unusable in raw form (too many similar-colored layers)
- **BBBike**: Virtually unusable, 20+ year old UX, no modern expectations met
- **Komoot ADFC**: Couldn't find family-friendly collections as advertised
- **ADFC paper map**: Is there a PDF available somewhere?

## Why Build This?

Existing tools either:
1. Have good data but no routing (InfraVelo, CyclOSM)
2. Have routing but poor UX and no customization (BBBike)
3. Have good UX but wrong routing logic for families (Google/Apple Maps)

**This tool combines:**
- OSM's comprehensive data
- Custom routing logic for family safety preferences
- Modern, usable UX
- Community feedback loop
