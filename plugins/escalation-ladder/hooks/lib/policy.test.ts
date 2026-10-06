import { describe, expect, test } from 'claude-code/testing'

import { decide } from './decide'
import { PRESETS, freshRun, normalizePolicy } from './policy'

const P = PRESETS.balanced!

describe('normalizePolicy', () => {
  test('non-object input falls back to the balanced preset', () => {
    for (const bad of [null, undefined, 42, 'x', NaN]) {
      const p = normalizePolicy(bad)
      expect(p.baseTier).toBe(P.baseTier)
      expect(p.tiers.length).toBe(P.tiers.length)
    }
  })
  test('cooldownSteps below 1 is clamped to 1', () => {
    expect(normalizePolicy({ cooldownSteps: 0 }).cooldownSteps).toBe(1)
    expect(normalizePolicy({ cooldownSteps: -5 }).cooldownSteps).toBe(1)
  })
  test('baseTier is clamped into the tier range', () => {
    expect(normalizePolicy({ baseTier: 99 }).baseTier).toBe(P.tiers.length - 1)
    expect(normalizePolicy({ baseTier: -3 }).baseTier).toBe(0)
  })
  test('non-finite numbers use the preset default', () => {
    expect(normalizePolicy({ cooldownSteps: NaN }).cooldownSteps).toBe(P.cooldownSteps)
    expect(normalizePolicy({ cooldownSteps: Infinity }).cooldownSteps).toBe(P.cooldownSteps)
  })
  test('fewer than 2 tiers falls back to the default tiers', () => {
    const p = normalizePolicy({ tiers: [{ id: 'only', model: 'sonnet', effort: 'low' }] })
    expect(p.tiers.length).toBe(P.tiers.length)
  })
  test('aliases map to full ids, full ids pass through', () => {
    const p = normalizePolicy({
      tiers: [
        { id: 'a', model: 'Haiku', effort: 'low' },
        { id: 'b', model: 'claude-opus-5-5', effort: 'max' },
      ],
    })
    expect(p.tiers[0]!.model).toBe('claude-haiku-4-5-20251001')
    expect(p.tiers[1]!.model).toBe('claude-opus-5-5')
  })
  test('reviewerTier is clamped to the tier count', () => {
    expect(normalizePolicy({ review: { reviewerTier: 50 } }).review.reviewerTier).toBe(P.tiers.length - 1)
  })
  test('invalid review mode uses the default', () => {
    expect(normalizePolicy({ review: { mode: 'bogus' } }).review.mode).toBe(P.review.mode)
  })
})

describe('decide when pinned', () => {
  const pinned = { ...freshRun(P), pinned: true, tier: 1 }
  test('every escalating signal holds and never trips', () => {
    const sigs = [
      { kind: 'loop', detail: 'x' },
      { kind: 'error-streak', n: 9 },
      { kind: 'step-budget', steps: 99 },
      { kind: 'truncated' },
      { kind: 'refusal' },
      { kind: 'review-failed', issues: 'bad' },
    ] as const
    for (const s of sigs) expect(decide(s, pinned, P).op).toBe('hold')
  })
})
