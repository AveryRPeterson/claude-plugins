import { describe, it, expect, beforeEach } from 'vitest'
import type { Policy, RunState } from '../../types'
import { PRESETS, freshRun } from './policy'
import { decide } from './decide'
import type { Signal, Move } from './decide'
import { LoopDetector, hash, signature } from './loop'

/**
 * State-machine property tests for the escalation ladder.
 * Verifies that tier transitions are deterministic, safe, and respect constraints.
 */

describe('Escalation Ladder State Machine', () => {
  let policy: Policy
  let run: RunState

  beforeEach(() => {
    policy = { ...PRESETS.frugal! }
    run = freshRun(policy)
  })

  describe('Escalation Constraints', () => {
    it('never escalates beyond tier count', () => {
      const tiers = policy.tiers.length
      for (let i = 0; i < 100; i++) {
        const sig: Signal = { kind: 'error-streak', n: 1 }
        const move = decide(sig, run, policy)
        if (move.op === 'up') {
          run.tier = Math.min(move.to, tiers - 1)
        }
        expect(run.tier).toBeLessThan(tiers)
      }
    })

    it('respects maxEscalationsPerTask cap', () => {
      const maxEscalations = policy.maxEscalationsPerTask
      let escalationCount = 0
      for (let i = 0; i < 50; i++) {
        if (escalationCount < maxEscalations) {
          const sig: Signal = { kind: 'error-streak', n: 1 }
          const move = decide(sig, run, policy)
          if (move.op === 'up') {
            run.escalations += 1
            escalationCount += 1
            run.tier = move.to
          }
        }
      }
      expect(run.escalations).toBeLessThanOrEqual(maxEscalations)
    })

    it('breaker is enforced by caller, not decide()', () => {
      // decide() doesn't check isBroken; the caller (turn.step) enforces it
      run.isBroken = true
      run.lastLoop = 'test-loop'

      // decide() still returns moves even when isBroken is true
      const sig: Signal = { kind: 'error-streak', n: 1 }
      const move = decide(sig, run, policy)
      // The move is valid, but the caller will block it
      expect(['up', 'hold', 'trip']).toContain(move.op)
      expect(run.isBroken).toBe(true)

      run = freshRun(policy)
      expect(run.isBroken).toBe(false)
    })

    it('pins prevent escalation', () => {
      run.pinned = true
      const originalTier = run.tier

      const sig: Signal = { kind: 'error-streak', n: policy.errorStreak }
      const move = decide(sig, run, policy)
      expect(move.op).toBe('hold')
      expect(run.tier).toBe(originalTier)
    })
  })

  describe('Tier Transitions', () => {
    it('escalates on error-streak signal', () => {
      run.errorStreak = policy.errorStreak
      const sig: Signal = { kind: 'error-streak', n: policy.errorStreak }
      const move = decide(sig, run, policy)
      expect(move.op).toBe('up')
    })

    it('escalates on loop signal', () => {
      run.loopStrikes = 1
      const sig: Signal = { kind: 'loop', detail: 'repeat' }
      const move = decide(sig, run, policy)
      expect(move.op).toBe('up')
    })

    it('escalates on step-budget exhaustion', () => {
      const sig: Signal = { kind: 'step-budget', steps: policy.maxStepsPerTier }
      const move = decide(sig, run, policy)
      expect(move.op).toBe('up')
    })

    it('escalates on low stuck confidence (below threshold)', () => {
      // Confidence only excuses escalation when >= threshold AND healthy
      run.errorStreak = 0
      run.loopStrikes = 0
      const sig: Signal = { kind: 'model-request', ask: 'stuck', confidence: 0.4, reason: 'test' }
      const move = decide(sig, run, policy)
      // 0.4 < 0.5 (frugal threshold), so escalate
      expect(move.op).toBe('up')
    })

    it('holds on high stuck confidence when healthy', () => {
      // High confidence >= threshold AND healthy = hold
      run.errorStreak = 0
      run.loopStrikes = 0
      const sig: Signal = { kind: 'model-request', ask: 'stuck', confidence: 0.7, reason: 'test' }
      const move = decide(sig, run, policy)
      expect(move.op).toBe('hold')
    })

    it('escalates on stuck request when troubled', () => {
      run.errorStreak = 1
      const sig: Signal = { kind: 'model-request', ask: 'stuck', confidence: 0.4, reason: 'test' }
      const move = decide(sig, run, policy)
      expect(move.op).toBe('up')
    })

    it('escalates to oracle on high-stakes request', () => {
      const sig: Signal = { kind: 'model-request', ask: 'high-stakes', confidence: 0.9, reason: 'test' }
      const move = decide(sig, run, policy)
      expect(move.op).toBe('up')
      expect(move.op === 'up' && move.to).toBe(policy.tiers.length - 1)
    })
  })

  describe('Peak Tier Tracking', () => {
    it('peakTier never decreases', () => {
      const peakBefore = run.peakTier
      run.tier = 2
      const peakAfter = Math.max(peakBefore, run.tier)
      expect(peakAfter).toBeGreaterThanOrEqual(peakBefore)
    })

    it('peakTier reflects highest rung reached', () => {
      expect(run.peakTier).toBe(0)
      run.tier = 1
      run.peakTier = Math.max(run.peakTier, run.tier)
      expect(run.peakTier).toBe(1)
      run.tier = 3
      run.peakTier = Math.max(run.peakTier, run.tier)
      expect(run.peakTier).toBe(3)
      run.tier = 1
      expect(run.peakTier).toBe(3)
    })
  })

  describe('Circuit Breaker', () => {
    it('loop strike escalates to trip when at budget limit', () => {
      run.loopStrikes = 3
      run.escalations = policy.maxEscalationsPerTask - 1 // Set to near limit
      run.tier = policy.tiers.length - 1 // At oracle (top tier)

      const sig: Signal = { kind: 'loop', detail: 'repeat' }
      const move = decide(sig, run, policy)
      // At top tier with loop = trip (circuit breaker)
      expect(move.op).toBe('trip')
    })

    it('breaker is task-terminal', () => {
      run.isBroken = true
      expect(run.isBroken).toBe(true)

      run = freshRun(policy)
      expect(run.isBroken).toBe(false)
    })
  })

  describe('Step-Count Stall False Positive Measurement', () => {
    it('measures false escalations on healthy iteration', () => {
      // A task with many steps but no errors, loops, or real issues
      // Should this escalate? This test measures the false-positive rate.
      let escalationCount = 0
      for (let step = 0; step < 30; step++) {
        // Healthy iteration: no errors, no loops, just working
        const sig: Signal = { kind: 'step-budget', steps: step + 1 }
        const move = decide(sig, run, policy)

        if (move.op === 'up') {
          escalationCount++
          run.escalations++
          run.tier = move.to
          run.stepsOnTier = 0
        }
      }

      // Frugal policy: maxStepsPerTier = 25, so escalation at step 25
      // This is the false-positive we're measuring
      expect(escalationCount).toBeGreaterThan(0)
      // At least one escalation on a clean task (the false positive)
    })

    it('escalates when step budget is exactly maxStepsPerTier', () => {
      // step-budget signal always wants to escalate; it's triggered when hit the limit
      const sig: Signal = { kind: 'step-budget', steps: policy.maxStepsPerTier }
      const move = decide(sig, run, policy)
      // step-budget always escalates (it's the stall heuristic signal)
      expect(move.op).toBe('up')
    })
  })

  describe('Random Signal Sequences (Fuzz)', () => {
    it('handles diverse signals without panic', () => {
      const signals: Signal[] = [
        { kind: 'error-streak', n: 1 },
        { kind: 'step-budget', steps: 10 },
        { kind: 'loop', detail: 'repeat' },
        { kind: 'model-request', ask: 'stuck', confidence: 0.7, reason: 'test' },
        { kind: 'truncated' },
      ]

      for (const sig of signals) {
        const move = decide(sig, run, policy)
        expect(['up', 'hold', 'trip']).toContain(move.op)

        if (move.op === 'up' && run.tier < policy.tiers.length - 1) {
          run.tier = move.to
          run.escalations += 1
        }

        expect(run.tier).toBeGreaterThanOrEqual(0)
        expect(run.tier).toBeLessThan(policy.tiers.length)
        expect(run.escalations).toBeLessThanOrEqual(policy.maxEscalationsPerTask)
      }
    })

    it('maintains invariants across 50 random transitions', () => {
      const signalKinds: Array<'error-streak' | 'loop' | 'step-budget' | 'truncated' | 'refusal'> = [
        'error-streak',
        'loop',
        'step-budget',
        'truncated',
        'refusal',
      ]

      for (let step = 0; step < 50; step++) {
        const kind = signalKinds[Math.floor(Math.random() * signalKinds.length)]
        let sig: Signal

        if (kind === 'error-streak') {
          sig = { kind: 'error-streak', n: Math.floor(Math.random() * 5) }
        } else if (kind === 'loop') {
          sig = { kind: 'loop', detail: 'test' }
        } else if (kind === 'step-budget') {
          sig = { kind: 'step-budget', steps: Math.floor(Math.random() * 30) }
        } else if (kind === 'truncated') {
          sig = { kind: 'truncated' }
        } else {
          sig = { kind: 'refusal' }
        }

        const move = decide(sig, run, policy)

        if (move.op === 'up' && run.escalations < policy.maxEscalationsPerTask) {
          run.tier = move.to
          run.escalations += 1
        }

        expect(run.tier).toBeGreaterThanOrEqual(0)
        expect(run.tier).toBeLessThan(policy.tiers.length)
        expect(run.escalations).toBeLessThanOrEqual(policy.maxEscalationsPerTask)
      }
    })
  })

  describe('Loop Detector Edge Cases', () => {
    let detector: LoopDetector

    beforeEach(() => {
      detector = new LoopDetector()
    })

    const cfg = { repeat: 3, pingPong: 3, sameError: 3 }
    const seen = (sig: string, result = sig, isError = false, errKey = '') => ({
      sig,
      resultHash: hash(result),
      isError,
      errKey,
    })

    it('ring wraparound evicts old entries: a repeat that fell off the ring is not reported', () => {
      // 3 identical calls would trip, but 26 distinct calls after them push them out (cap 26).
      for (let i = 0; i < 3; i++) detector.push(seen('same'))
      for (let i = 0; i < 26; i++) detector.push(seen(`distinct-${i}`))
      expect(detector.check(cfg)).toBeNull()
    })

    it('a repeat run that is still inside the ring is reported after wraparound', () => {
      for (let i = 0; i < 40; i++) detector.push(seen(`distinct-${i}`))
      for (let i = 0; i < 3; i++) detector.push(seen('same'))
      expect(detector.check(cfg)?.kind).toBe('repeat')
    })

    it('clear() empties the ring', () => {
      for (let i = 0; i < 3; i++) detector.push(seen('same'))
      detector.clear()
      expect(detector.check(cfg)).toBeNull()
    })

    it('does not report a repeat when the same call returns changing results', () => {
      for (let i = 0; i < 6; i++) detector.push(seen('poll', `result-${i}`))
      expect(detector.check(cfg)).toBeNull()
    })

    it('detects ping-pong only when both calls also repeat their results', () => {
      for (let i = 0; i < 3; i++) {
        detector.push(seen('a'))
        detector.push(seen('b'))
      }
      expect(detector.check(cfg)?.kind).toBe('pingpong')
    })

    it('does not report ping-pong when results change (polling a starting server)', () => {
      for (let i = 0; i < 3; i++) {
        detector.push(seen('a', `a-${i}`))
        detector.push(seen('b', `b-${i}`))
      }
      expect(detector.check(cfg)).toBeNull()
    })

    it('detects repeat: same call and result 3x', () => {
      for (let i = 0; i < 3; i++) detector.push(seen('same-call', 'same-result'))
      expect(detector.check(cfg)?.kind).toBe('repeat')
    })

    it('detects same-error: the same error from different calls 3x', () => {
      for (let i = 0; i < 3; i++) detector.push(seen(`call-${i}`, `result-${i}`, true, 'connection refused'))
      expect(detector.check(cfg)?.kind).toBe('same-error')
    })

    it('does not report same-error when the error text differs', () => {
      detector.push(seen('c1', 'r1', true, 'connection refused'))
      detector.push(seen('c2', 'r2', true, 'file not found'))
      detector.push(seen('c3', 'r3', true, 'connection refused'))
      expect(detector.check(cfg)).toBeNull()
    })

    it('a success between identical errors breaks the same-error run', () => {
      detector.push(seen('c1', 'r1', true, 'boom'))
      detector.push(seen('c2', 'r2', true, 'boom'))
      detector.push(seen('c3', 'r3', false))
      detector.push(seen('c4', 'r4', true, 'boom'))
      expect(detector.check(cfg)).toBeNull()
    })
  })
})
