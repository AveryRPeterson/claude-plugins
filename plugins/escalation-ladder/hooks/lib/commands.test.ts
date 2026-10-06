import { describe, expect, test } from 'claude-code/testing'

import { HELP, SETTINGS, STEPPERS, applySet, applyTier, formatStatus, gaugeSvg, listSettings, listTiers } from './commands'
import { PRESETS, freshRun } from './policy'

const P = PRESETS.balanced!

describe('/ladder set', () => {
  test('sets an int and reports the stored value', () => {
    const r = applySet(P, 'cooldown', '6')
    expect(r.ok && r.policy.cooldownSteps).toBe(6)
    expect(r.ok && r.note).toBe('cooldown = 6')
  })
  test('out-of-range values are clamped and said so', () => {
    const r = applySet(P, 'cooldown', '-5')
    expect(r.ok && r.policy.cooldownSteps).toBe(1)
    expect(r.ok && r.note).toContain('clamped from -5')
    const t = applySet(P, 'loopPingPong', '99')
    expect(t.ok && t.policy.loop.pingPong).toBe(12)
  })
  test('fraction setting keeps decimals', () => {
    const r = applySet(P, 'confidence', '0.35')
    expect(r.ok && r.policy.confidenceThreshold).toBe(0.35)
  })
  test('enum accepts only listed values', () => {
    expect(applySet(P, 'reviewMode', 'task').ok).toBe(true)
    const bad = applySet(P, 'reviewMode', 'always')
    expect(!bad.ok && bad.error).toContain('off, task, milestone, both')
  })
  test('rejects unknown keys, missing and non-numeric values without changing anything', () => {
    expect(applySet(P, 'nope', '1').ok).toBe(false)
    expect(applySet(P, 'cooldown', undefined).ok).toBe(false)
    expect(applySet(P, 'cooldown', 'abc').ok).toBe(false)
    expect(applySet(P, 'cooldown', 'NaN').ok).toBe(false)
    expect(P.cooldownSteps).toBe(PRESETS.balanced!.cooldownSteps)
  })
  test('every documented setting reads back what it was set to', () => {
    for (const [k, s] of Object.entries(SETTINGS)) {
      const cur = s.get(P)
      const r = applySet(P, k, String(cur))
      expect(r.ok).toBe(true)
      expect(r.ok && s.get(r.policy)).toBe(cur)
    }
  })
  test('get lists every key', () => {
    const out = listSettings(P)
    for (const k of Object.keys(SETTINGS)) expect(out).toContain(k)
  })
})

describe('/ladder tier', () => {
  test('edits one rung, resolving aliases, leaving the rest', () => {
    const r = applyTier(P, '0', 'sonnet', 'high')
    expect(r.ok && r.policy.tiers[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' })
    expect(r.ok && r.policy.tiers[3]).toEqual(P.tiers[3])
  })
  test('validates rung, model and effort', () => {
    expect(applyTier(P, '9', 'opus', 'max').ok).toBe(false)
    expect(applyTier(P, 'x', 'opus', 'max').ok).toBe(false)
    expect(applyTier(P, '1', undefined, 'max').ok).toBe(false)
    expect(applyTier(P, '1', 'opus', 'ultra').ok).toBe(false)
    expect(applyTier(P, undefined, undefined, undefined).ok).toBe(false)
  })
  test('list marks the current rung', () => {
    const out = listTiers(P, { ...freshRun(P), tier: 2 })
    expect(out).toContain('2* senior')
  })
})

describe('/ladder status and help', () => {
  test('status shows state, rung, counters', () => {
    const out = formatStatus({ ...freshRun(P), tier: 2, pinned: true, escalations: 1, loopStrikes: 2 }, P)
    expect(out).toContain('ON, pinned')
    expect(out).toContain('Rung 2/3: senior')
    expect(out).toContain('Escalations 1/4')
    expect(out).toContain('loop strikes 2/3')
  })
  test('status distinguishes off and breaker states', () => {
    expect(formatStatus({ ...freshRun(P), enabled: false }, P)).toContain('Ladder: OFF')
    expect(formatStatus({ ...freshRun(P), isBroken: true }, P)).toContain('STOPPED (breaker)')
  })
  test('help names every subcommand', () => {
    for (const c of ['status', 'on', 'off', 'probe', 'log', 'up', 'down', 'pin', 'unpin', 'reset', 'preset', 'get', 'set', 'tier']) {
      expect(HELP.split(/\W+/)).toContain(c)
    }
  })
})

describe('button-only pane pieces', () => {
  test('gauge is well-formed SVG with one highlighted rung and escaped text', () => {
    const svg = gaugeSvg(P, { ...freshRun(P), tier: 2 })
    expect(svg.startsWith('<svg ')).toBe(true)
    expect(svg.endsWith('</svg>')).toBe(true)
    expect((svg.match(/#2e7d32/g) ?? []).length).toBe(1)
    expect((svg.match(/<rect /g) ?? []).length).toBe(P.tiers.length)
    const odd = gaugeSvg({ ...P, tiers: P.tiers.map((t, i) => (i === 0 ? { ...t, id: 'a<b&c' } : t)) }, freshRun(P))
    expect(odd).toContain('a&lt;b&amp;c')
    expect(svg.length).toBeLessThan(131072)
  })
  test('every stepper key is a real setting and a step stays within its clamps', () => {
    for (const s of STEPPERS) {
      expect(SETTINGS[s.key]).toBeDefined()
      const cur = Number(SETTINGS[s.key]!.get(P))
      expect(applySet(P, s.key, String(cur + s.step)).ok).toBe(true)
      const down = applySet(P, s.key, String(cur - 1000))
      expect(down.ok).toBe(true)
    }
  })
})

describe('ask telemetry', () => {
  test('status shows request and consult counts, tolerating a run stored before they existed', () => {
    expect(formatStatus({ ...freshRun(P), escalationRequests: 3, consults: 2 }, P)).toContain('3 escalation requests, 2 oracle consults')
    const old = { ...freshRun(P) } as Record<string, unknown>
    delete old.escalationRequests
    delete old.consults
    expect(formatStatus(old as never, P)).toContain('0 escalation requests, 0 oracle consults')
  })
})
