import { describe, expect, test } from 'claude-code/testing'

import { decide } from './decide'
import { LoopDetector, errorKey, signature } from './loop'
import { PRESETS, freshRun, normalizePolicy, peakAfter, pickReviewer, startsNewTask } from './policy'
import { buildEvidence, parseVerdict } from './review'

const P = PRESETS.balanced!
const run = (o = {}) => ({ ...freshRun(P), ...o })
const seen = (sig: string, res = 'r', isError = false, err = 'e') => ({ sig, resultHash: res, isError, errKey: err })

describe('parseVerdict', () => {
  test('prose with braces before the JSON still yields the verdict', () => {
    const t = 'Saw `function f() { return 1 }`. {"verdict":"fail","issues":["no test run"]}'
    expect(parseVerdict(t)).toEqual({ verdict: 'fail', issues: ['no test run'] })
  })
  test('fenced JSON followed by stray braces', () => {
    expect(parseVerdict('```json\n{"verdict":"fail","issues":[]}\n```\nSee {x}').verdict).toBe('fail')
  })
  test('case-insensitive verdict', () => {
    expect(parseVerdict('{"verdict":"FAIL","issues":["x"]}').verdict).toBe('fail')
    expect(parseVerdict('{"verdict":" Pass "}').verdict).toBe('pass')
  })
  test('issues as a string or objects are kept as text', () => {
    expect(parseVerdict('{"verdict":"fail","issues":"no tests"}').issues).toEqual(['no tests'])
    expect(parseVerdict('{"verdict":"fail","issues":[{"file":"a"}]}').issues[0]).toContain('"file"')
  })
  test('unknown verdict word and truncated JSON are unsure', () => {
    expect(parseVerdict('{"verdict":"maybe"}').verdict).toBe('unsure')
    expect(parseVerdict('{"verdict":"fail","issues":["a"').verdict).toBe('unsure')
  })
})

describe('loop detector hardening', () => {
  test('ping-pong with changing results (polling) is not a loop', () => {
    const d = new LoopDetector()
    for (let i = 0; i < 6; i++) d.push(seen(i % 2 ? 'b' : 'a', `r${i}`))
    expect(d.check(P.loop)).toBe(null)
  })
  test('ping-pong with repeating results still fires', () => {
    const d = new LoopDetector()
    for (let i = 0; i < 6; i++) d.push(seen(i % 2 ? 'b' : 'a', i % 2 ? 'rb' : 'ra'))
    expect(d.check(P.loop)?.kind).toBe('pingpong')
  })
  test('ping-pong at the clamped maximum fits the ring', () => {
    const pp = normalizePolicy({ loop: { pingPong: 99 } }).loop.pingPong
    expect(pp).toBe(12)
    const d = new LoopDetector()
    for (let i = 0; i < pp * 2; i++) d.push(seen(i % 2 ? 'b' : 'a', i % 2 ? 'rb' : 'ra'))
    expect(d.check({ ...P.loop, pingPong: pp })?.kind).toBe('pingpong')
  })
  test('rewording a Bash description does not change the signature', () => {
    const a = signature('Bash', { command: 'npm test', description: 'Run tests' })
    const b = signature('Bash', { command: 'npm test', description: 'Re-run the suite', timeout: 5000 })
    expect(a).toBe(b)
    expect(a).not.toBe(signature('Bash', { command: 'npm run build' }))
  })
  test('error key ignores the leading banner, paths and hashes', () => {
    const banner = '=== test session starts ===\nplatform win32\n'.repeat(12)
    expect(errorKey(`${banner}FAILED test_a - AssertionError`)).not.toBe(errorKey(`${banner}FAILED test_b - KeyError`))
    expect(errorKey("ENOENT '/tmp/jest_ab12cd/x'")).toBe(errorKey("ENOENT '/tmp/jest_ef34gh/x'"))
    expect(errorKey('bad ref 3f2a9c1d7e')).toBe(errorKey('bad ref 8b7c6d5e4f'))
  })
})

describe('decide hardening', () => {
  const top = run({ tier: 3 })
  test('truncated, refusal, stall and error streak at the top hold instead of tripping', () => {
    for (const s of [{ kind: 'truncated' }, { kind: 'refusal' }, { kind: 'step-budget', steps: 99 }, { kind: 'error-streak', n: 9 }] as const) {
      expect(decide(s, top, P).op).toBe('hold')
    }
  })
  test('out of budget below the top: stall holds, loop still trips', () => {
    const spent = run({ tier: 1, escalations: P.maxEscalationsPerTask })
    expect(decide({ kind: 'step-budget', steps: 99 }, spent, P).op).toBe('hold')
    expect(decide({ kind: 'loop', detail: 'x' }, spent, P).op).toBe('trip')
  })
  test('percent-style and NaN confidence are normalised', () => {
    expect(decide({ kind: 'model-request', confidence: 40, ask: 'stuck', reason: '' }, run({ tier: 0 }), P).op).toBe('up')
    expect(decide({ kind: 'model-request', confidence: 95, ask: 'stuck', reason: '' }, run({ tier: 0 }), P).op).toBe('hold')
    expect(decide({ kind: 'model-request', confidence: NaN, ask: 'stuck', reason: '' }, run({ tier: 0 }), P).op).toBe('up')
  })
  test('high-stakes escalates to the top even when confident', () => {
    const m = decide({ kind: 'model-request', confidence: 0.9, ask: 'high-stakes', reason: '' }, run({ tier: 0 }), P)
    expect(m).toMatchObject({ op: 'up', to: 3 })
  })
})

describe('normalizePolicy hardening', () => {
  test('tiers with missing model or bad entries are repaired or replaced, never throw', () => {
    expect(normalizePolicy({ tiers: [{ id: 'a' }, { id: 'b' }] }).tiers.length).toBe(P.tiers.length)
    expect(normalizePolicy({ tiers: [null, null] }).tiers.length).toBe(P.tiers.length)
  })
  test('invalid effort falls back to medium; missing id gets a name', () => {
    const t = normalizePolicy({ tiers: [{ model: 'haiku', effort: 'ultra' }, { id: 'b', model: 'opus', effort: 'max' }] }).tiers
    expect(t[0]).toMatchObject({ effort: 'medium', id: 'tier0', model: 'claude-haiku-4-5-20251001' })
  })
  test('index fields are rounded to integers', () => {
    const p = normalizePolicy({ baseTier: 1.5, review: { reviewerTier: 2.5 } })
    expect(Number.isInteger(p.baseTier)).toBe(true)
    expect(Number.isInteger(p.review.reviewerTier)).toBe(true)
  })
  test('confidenceThreshold stays fractional', () => {
    expect(normalizePolicy({ confidenceThreshold: 0.35 }).confidenceThreshold).toBe(0.35)
  })
})

describe('review cascade', () => {
  test('peak tracks the rung a step ran on, even when it never moved, and tolerates a missing prior value', () => {
    expect(peakAfter(0, 1)).toBe(1)
    expect(peakAfter(3, 1)).toBe(3)
    expect(peakAfter(undefined, 2)).toBe(2)
    expect(pickReviewer(peakAfter(0, 1), P)).toBe(P.review.reviewerTier)
  })
  test('reviewer is one rung above the heaviest tier used, never below the policy floor', () => {
    expect(pickReviewer(0, P)).toBe(P.review.reviewerTier)
    expect(pickReviewer(2, P)).toBe(3)
    expect(pickReviewer(3, P)).toBe(3)
    const lowFloor = { ...P, review: { ...P.review, reviewerTier: 0 } }
    expect(pickReviewer(0, lowFloor)).toBe(1)
  })
})

describe('buildEvidence hardening', () => {
  const row = (role: 'user' | 'assistant', text: string, toolUses: never[] = []) => ({ role, text, toolUses })
  test('a plugin follow-up prompt does not replace the original task', () => {
    const rows = [
      row('user', 'Fix the bug in parser.ts'),
      row('assistant', 'Done.'),
      row('user', '[escalation-ladder] An independent reviewer rejected your last answer:\n- no test'),
      row('assistant', 'Now fixed.'),
    ]
    const ev = buildEvidence(rows, 'task')
    expect(ev).toContain('Fix the bug in parser.ts')
    expect(ev).toContain('Now fixed.')
  })
  test('no user row in the window is reported, not guessed', () => {
    expect(buildEvidence([row('assistant', 'hi')], 'task')).toContain('outside the evidence window')
  })
  test('a tool use without input does not throw', () => {
    const rows = [row('user', 't'), { role: 'assistant' as const, text: 'a', toolUses: [{ tool: 'X' } as never] }]
    expect(() => buildEvidence(rows, 'task')).not.toThrow()
  })
})

describe('what starts a new task', () => {
  test('a person, bridge, SDK or schedule starts one', () => {
    for (const k of ['composer', 'bridge', 'sdk', 'channel', 'slack-ping', 'auto-continuation', 'scheduled-trigger']) {
      expect(startsNewTask(k)).toBe(true)
    }
  })
  test('hand-backs, notifications and the ladder own follow-ups continue the task', () => {
    for (const k of ['plugin', 'task-notification', 'peer', 'peer-send-message', 'projects-relay', 'coordinator', 'observer', 'observer-activity', 'unclassified']) {
      expect(startsNewTask(k)).toBe(false)
    }
  })
})

describe('model requests are hints, behaviour is the evidence', () => {
  const ask = { kind: 'model-request', confidence: 0.95, ask: 'stuck', reason: 'sure' } as const
  test('high confidence excuses a request while the run looks healthy', () => {
    expect(decide(ask, run({ tier: 1 }), P).op).toBe('hold')
  })
  test('high confidence does not excuse it after an error streak or a loop strike', () => {
    expect(decide(ask, run({ tier: 1, errorStreak: 2 }), P).op).toBe('up')
    expect(decide(ask, run({ tier: 1, loopStrikes: 1 }), P).op).toBe('up')
  })
  test('low confidence always escalates', () => {
    expect(decide({ ...ask, confidence: 0.1 }, run({ tier: 1 }), P).op).toBe('up')
  })
})
