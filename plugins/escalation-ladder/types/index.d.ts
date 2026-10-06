export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** One rung of the ladder. `model` is an alias (`haiku`) or a full model id. */
export type Tier = { id: string; model: string; effort: Effort }

export type Policy = {
  /** Ordered cheapest to strongest; the last rung is the oracle. */
  tiers: Tier[]
  /** Rung a task starts on and decays back to. */
  baseTier: number
  /** A self-reported confidence below this escalates. 0..1 */
  confidenceThreshold: number
  /** Steps on one rung, within a task, before escalating on suspicion of a stall. */
  maxStepsPerTier: number
  /** Consecutive tool errors before escalating. */
  errorStreak: number
  /** Clean steps on an escalated rung before stepping back down one. */
  cooldownSteps: number
  maxEscalationsPerTask: number
  /** Circuit breaker: hard stop for the whole task, whatever the rung. */
  maxStepsPerTask: number
  loop: { repeat: number; pingPong: number; sameError: number }
  review: {
    mode: 'off' | 'task' | 'milestone' | 'both'
    /** Rung (by index) whose model does the reviewing. */
    reviewerTier: number
    /** A task with fewer tool calls than this is not reviewed. */
    minToolCalls: number
    /** Review-then-fix rounds allowed per task. */
    maxRounds: number
  }
}

export type Spend = { steps: number; input: number; output: number; cacheRead: number }

export type RunState = {
  enabled: boolean
  tier: number
  /** Heaviest rung used in this task; picks the reviewer (review cascade). */
  peakTier: number
  /** toolCallsInTask at the last review, so unchanged work is not re-reviewed. */
  reviewedToolCalls: number
  /** request_escalation calls this task, whatever the outcome (consult-rate telemetry). */
  escalationRequests: number
  /** consult_oracle calls this task. */
  consults: number
  /** The user fixed the rung by hand; the ladder only observes. */
  pinned: boolean
  turnId: string | null
  stepsOnTier: number
  stepsInTask: number
  toolCallsInTask: number
  escalations: number
  cleanSteps: number
  errorStreak: number
  loopStrikes: number
  reviewRounds: number
  /** The circuit breaker has tripped for this task. */
  isBroken: boolean
  /** Token spend per tier id. */
  spend: Record<string, Spend>
  lastLoop: string | null
}

export type LadderEvent = {
  at: number
  kind: 'escalate' | 'deescalate' | 'loop' | 'review' | 'milestone' | 'breaker' | 'manual' | 'hold' | 'reset' | 'reload'
  from?: number
  to?: number
  reason: string
}

declare module 'claude-code' {
  interface PluginState {
    'escalation-ladder': {
      run: RunState
      policy: Policy
      log: LadderEvent[]
    }
  }
}
