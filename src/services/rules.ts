export interface ClassificationRule {
  match: Record<string, string>
  classification: string
  travelModes: Record<string, 'preferred' | 'other'>
}

export interface RegionRules {
  rules: ClassificationRule[]
  legendItems: Array<{ name: string; icon: string; description: string }>
}

export async function fetchRules(region: string): Promise<RegionRules> {
  const resp = await fetch(`/api/rules/${encodeURIComponent(region)}`)
  return resp.json()
}

export async function saveRules(region: string, rules: RegionRules): Promise<void> {
  await fetch(`/api/rules/${encodeURIComponent(region)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rules),
  })
}
