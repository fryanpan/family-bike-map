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

// Gradient caps added 2026-05-10. The actual gating logic is exercised
// in clientRouter.test.ts; these tests just pin the per-mode threshold
// values so an accidental edit (or skipped mode) gets caught.
describe('mode gradient caps', () => {
  it('kid modes default to 5% sustained grade (AASHTO shared-use-path)', () => {
    expect(MODE_RULES['kid-starting-out'].gradientCapPct).toBe(5)
    expect(MODE_RULES['kid-confident'].gradientCapPct).toBe(5)
  })

  it('older-kid and carrying-kid lift to 7%', () => {
    expect(MODE_RULES['kid-traffic-savvy'].gradientCapPct).toBe(7)
    expect(MODE_RULES['carrying-kid'].gradientCapPct).toBe(7)
  })

  it('training accepts 8% (short-burst AASHTO)', () => {
    expect(MODE_RULES.training.gradientCapPct).toBe(8)
  })

  it('caps are monotonic with rider strength', () => {
    const order = ['kid-starting-out', 'kid-confident', 'kid-traffic-savvy', 'carrying-kid', 'training'] as const
    for (let i = 1; i < order.length; i++) {
      const prev = MODE_RULES[order[i - 1]].gradientCapPct!
      const curr = MODE_RULES[order[i]].gradientCapPct!
      expect(curr).toBeGreaterThanOrEqual(prev)
    }
  })
})
