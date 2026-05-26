import { describe, it, expect } from 'bun:test'
import { MODE_RULES, applyModeRule } from '../src/data/modes'
import { classifyEdge } from '../src/utils/lts'

// Minimal, focused tests for the smoothness-aware rough penalty added
// 2026-04-23. Bryan observed bike paths with smoothness=bad/horrible
// being routed through at full speed because applyModeRule only looked
// at the `surface` tag.

describe('applyModeRule — smoothness', () => {
  const kidRule = MODE_RULES['kid-starting-out']
  const roughMul = kidRule.roughSurfaceMultiplier ?? 1.0
  const smooth = (s: string) => classifyEdge({ highway: 'cycleway', surface: 'asphalt', smoothness: s })
  const baseline = classifyEdge({ highway: 'cycleway', surface: 'asphalt' })

  it('asphalt cycleway with no smoothness tag → no rough penalty', () => {
    const d = applyModeRule(kidRule, baseline)
    expect(d.accepted).toBe(true)
    if (d.accepted) expect(d.costMultiplier).toBe(1.0)
  })

  it('smoothness=intermediate → no rough penalty (explicitly OK)', () => {
    const d = applyModeRule(kidRule, smooth('intermediate'))
    expect(d.accepted).toBe(true)
    if (d.accepted) expect(d.costMultiplier).toBe(1.0)
  })

  for (const s of ['bad', 'very_bad', 'horrible', 'very_horrible', 'impassable']) {
    it(`smoothness=${s} → rough penalty applied despite surface=asphalt`, () => {
      const d = applyModeRule(kidRule, smooth(s))
      expect(d.accepted).toBe(true)
      if (d.accepted) expect(d.costMultiplier).toBe(roughMul)
    })
  }

  it('classifyEdge exposes smoothness on the classification', () => {
    expect(classifyEdge({ highway: 'cycleway', smoothness: 'horrible' }).smoothness).toBe('horrible')
    expect(classifyEdge({ highway: 'cycleway' }).smoothness).toBe(null)
  })
})

// BRouter-style ascent cost replaced binary gradient gate on 2026-05-26.
// These tests pin the per-mode uphillCostSecPerMeter values so an
// accidental edit (or skipped mode) gets caught. Cost decreases as the
// mode tolerates more climbing.
describe('mode ascent cost', () => {
  it('kid-starting-out penalises climbing most heavily', () => {
    expect(MODE_RULES['kid-starting-out'].uphillCostSecPerMeter).toBe(40)
  })

  it('values descend with rider strength (kid → training)', () => {
    expect(MODE_RULES['kid-starting-out'].uphillCostSecPerMeter).toBe(40)
    expect(MODE_RULES['kid-confident'].uphillCostSecPerMeter).toBe(25)
    expect(MODE_RULES['kid-traffic-savvy'].uphillCostSecPerMeter).toBe(15)
    expect(MODE_RULES['carrying-kid'].uphillCostSecPerMeter).toBe(20)
    expect(MODE_RULES['training'].uphillCostSecPerMeter).toBe(7)
  })

  it('costs are non-increasing for the kid skill ladder', () => {
    // Carrying-kid breaks strict monotonicity (heavier than solo-confident
    // even though adult-piloted) — the kid ladder alone should descend.
    const kidLadder = ['kid-starting-out', 'kid-confident', 'kid-traffic-savvy'] as const
    for (let i = 1; i < kidLadder.length; i++) {
      const prev = MODE_RULES[kidLadder[i - 1]].uphillCostSecPerMeter!
      const curr = MODE_RULES[kidLadder[i]].uphillCostSecPerMeter!
      expect(curr).toBeLessThanOrEqual(prev)
    }
  })
})
