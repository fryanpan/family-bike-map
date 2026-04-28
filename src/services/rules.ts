// Region rules type definitions, retained as the parameter shape
// flowing through the classifier / overlay / router. The HTTP API that
// used to populate them (GET/PUT /api/rules/:region, KV-backed) was
// removed 2026-04-28 — it was unauthenticated and wasn't being used.
// Static rules from future code-side region profiles can plug in as
// `ClassificationRule[]` without re-introducing a write endpoint.

export interface ClassificationRule {
  match: Record<string, string>
  classification: string
  travelModes: Record<string, 'preferred' | 'other'>
}

export interface RegionRules {
  rules: ClassificationRule[]
  legendItems: Array<{ name: string; icon: string; description: string }>
}
