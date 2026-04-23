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
