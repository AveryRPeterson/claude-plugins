import { describe, expect, test } from 'claude-code/testing'

import { decide, shouldStepDown } from './decide'
import { LoopDetector, errorKey, signature } from './loop'
import { PRESETS, freshRun, normalizePolicy } from './policy'
import { buildEvidence, parseVerdict } from './review'

const P = PRESETS.balanced!
const seen = (sig: string, res = 'r', isError = false, err = 'e') => ({
  sig,
  resultHash: res,
  isError,
  errKey: err,
})

describe('loop detector', () => {
  test('identical call+result 3x trips; different result does not', () => {
    const d = new LoopDetector()
    d.push(seen('a', '1'))
    d.push(seen('a', '2'))
    d.push(seen('a', '3'))
    expect(d.check(P.loop)).toBe(null)
    const e = new LoopDetector()
    for (let i = 0; i < 3; i++) e.push(seen('a', 'same'))
    expect(e.check(P.loop)?.kind).toBe('repeat')
  })
  test('A/B alternation with repeating results trips', () => {
    const d = new LoopDetector()
    for (let i = 0; i < 6; i++) d.push(seen(i % 2 ? 'b' : 'a', i % 2 ? 'rb' : 'ra'))
    expect(d.check(P.loop)?.kind).toBe('pingpong')
  })
  test('same error across different calls trips', () => {
    const d = new LoopDetector()
    for (let i = 0; i < 3; i++) d.push(seen(`c${i}`, `r${i}`, true, 'boom'))
    expect(d.check(P.loop)?.kind).toBe('same-error')
  })
  test('signature ignores key order and whitespace; error key ignores numbers', () => {
    expect(signature('Bash', { command: 'ls   -la', a: 1 })).toBe(signature('Bash', { a: 1, command: 'ls -la' }))
    expect(errorKey('failed at line 41')).toBe(errorKey('failed at line 52'))
  })
})

describe('decide', () => {
  const run = (o = {}) => ({ ...freshRun(P), ...o })
  test('high confidence is held, low confidence climbs one rung', () => {
    expect(decide({ kind: 'model-request', confidence: 0.9, ask: 'stuck', reason: '' }, run(), P).op).toBe('hold')
    const m = decide({ kind: 'model-request', confidence: 0.2, ask: 'stuck', reason: 'x' }, run({ tier: 1 }), P)
    expect(m).toEqual({ op: 'up', to: 2, reason: expect.any(String) })
  })
  test('deeper-reasoning jumps straight to oracle regardless of confidence', () => {
    const m = decide({ kind: 'model-request', confidence: 0.99, ask: 'deeper-reasoning', reason: '' }, run({ tier: 0 }), P)
    expect(m).toMatchObject({ op: 'up', to: P.tiers.length - 1 })
  })
  test('loop at the top tier trips the breaker; a model request there just holds', () => {
    const top = run({ tier: P.tiers.length - 1 })
    expect(decide({ kind: 'loop', detail: 'x' }, top, P).op).toBe('trip')
    expect(decide({ kind: 'model-request', confidence: 0, ask: 'stuck', reason: '' }, top, P).op).toBe('hold')
  })
  test('escalation budget exhaustion trips on a loop', () => {
    expect(decide({ kind: 'loop', detail: 'x' }, run({ escalations: P.maxEscalationsPerTask }), P).op).toBe('trip')
  })
  test('pinned tier never moves', () => {
    expect(decide({ kind: 'loop', detail: 'x' }, run({ pinned: true }), P).op).toBe('hold')
  })
  test('step-down only after cooldown, only above base', () => {
    expect(shouldStepDown(run({ tier: 3, cleanSteps: P.cooldownSteps }), P)).toBe(true)
    expect(shouldStepDown(run({ tier: 3, cleanSteps: 1 }), P)).toBe(false)
    expect(shouldStepDown(run({ tier: P.baseTier, cleanSteps: 99 }), P)).toBe(false)
  })
})

describe('policy + review parsing', () => {
  test('normalizePolicy repairs garbage', () => {
    const n = normalizePolicy({ baseTier: 99, confidenceThreshold: -4, review: { mode: 'nope' } })
    expect(n.baseTier).toBe(n.tiers.length - 1)
    expect(n.confidenceThreshold).toBe(0)
    expect(n.review.mode).toBe(P.review.mode)
  })
  test('parseVerdict tolerates prose around JSON and bad output', () => {
    expect(parseVerdict('Sure: {"verdict":"fail","issues":["no test run"]}').verdict).toBe('fail')
    expect(parseVerdict('looks fine to me').verdict).toBe('unsure')
  })
  test('buildEvidence includes task, trail and answer', () => {
    const ev = buildEvidence(
      [
        { role: 'user', text: 'fix the bug', toolUses: [] },
        { role: 'assistant', text: 'done', toolUses: [{ tool: 'Bash', input: { command: 'npm test' }, text: 'ok', isError: false }] },
      ],
      'task',
    )
    expect(ev).toContain('fix the bug')
    expect(ev).toContain('npm test')
    expect(ev).toContain('FINAL ANSWER:\ndone')
  })
})
