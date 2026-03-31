# Vision: Bike Route Finder

## The Problem

Parents and families want to bike safely with their kids, but existing navigation tools fail them. Google and Apple Maps don't understand what makes a route family-safe. Route knowledge lives in people's heads, not in shareable maps.

**The gap**: No tool lets you say "I prioritize Fahrradstrasse over separated paths over quiet streets over busy roads" and get routes that match those preferences.

## Our Solution

A bike routing tool that understands **family-specific safety preferences** and provides routes that match your riding style.

### Today: Berlin

Help families quickly learn safe bike routes around Berlin, accounting for:
- Fahrradstrasse (bike streets where bikes have priority)
- Fully separated paths away from cars
- Quiet side streets (safe at certain times)
- Surface quality (avoiding cobblestones with trailer)

### Tomorrow: Worldwide

Expand to any city where people bike with kids:
- San Francisco
- Amsterdam
- Copenhagen
- Any place you visit with bikes

### Ultimate: Crowdsourced Global Map

Build a worldwide, community-driven map of kid-friendly bike infrastructure where:
- Users rate route segments
- Routes improve based on feedback
- Local knowledge becomes discoverable
- Families share what works

## Why This Matters

**For individuals**: Learn how to bike around a new city quickly, with confidence that routes match your safety needs.

**For families**: Stop guessing which streets are safe. Get routes optimized for riding with kids.

**For communities**: Share local knowledge. Make bike-friendly cities more accessible to newcomers and families.

## What Makes This Different

**Existing tools:**
- ❌ Good data but no routing (InfraVelo, CyclOSM)
- ❌ Routing but terrible UX (BBBike)
- ❌ Good UX but wrong routing logic (Google/Apple Maps)

**Our approach:**
- ✅ OSM's comprehensive data
- ✅ Custom routing logic for family safety
- ✅ Modern, usable interface
- ✅ Routes that learn from community feedback
- ✅ Works across cities worldwide

## Technical Foundation

**Open source first**: Built on OpenStreetMap data and open routing engines.

**Privacy-focused**: No user accounts required. Your routes, your data.

**Extensible**: Architecture supports any city with OSM data. Community can add new cities.

## Success Looks Like

1. **Routes work**: Families follow suggested routes without needing to deviate
2. **Routes improve**: Quality gets better over time based on feedback
3. **Knowledge transfers**: What works in Berlin helps bootstrap San Francisco
4. **Community grows**: Users contribute data for their cities
5. **Impact scales**: Tool helps families bike safely in cities worldwide

---

**Status**: Early planning phase. See `/docs/product/vision.md` for detailed requirements, `/docs/product/architecture.md` for technical design.
