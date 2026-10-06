import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
 
import type { Effort, LadderEvent, Policy, RunState, Tier } from '../types'
import { decide, shouldStepDown } from './lib/decide'
import type { Signal } from './lib/decide'
import { HELP, SETTINGS, STEPPERS, applySet, applyTier, formatStatus, gaugeSvg, listSettings, listTiers } from './lib/commands'
import { LoopDetector, errorKey, hash, signature } from './lib/loop'
import { DEFAULT_PRESET, PRESETS, freshRun, normalizePolicy, peakAfter, pickReviewer, startsNewTask, setTestModeStartsNewTask } from './lib/policy'
import { REVIEW_SYSTEM, buildEvidence, parseVerdict } from './lib/review'
import type { Verdict } from './lib/review'

const NAME = 'escalation-ladder'
const PANE = 'ladder'
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

const run$ = atom({ plugin: 'escalation-ladder', key: 'run' } as const, freshRun(PRESETS[DEFAULT_PRESET]!))
const policy$ = atom({ plugin: 'escalation-ladder', key: 'policy' } as const, PRESETS[DEFAULT_PRESET]!)
const log$ = atom({ plugin: 'escalation-ladder', key: 'log' } as const, [])

type Eng = EngineInterface
type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
} | null | undefined

const label = (t: Tier | undefined) => (t ? `${t.id} (${t.model}/${t.effort})` : '?')

// Transient, per-load bookkeeping. Anything a drawing reads lives in $.state.
const detectors = new Map<string, LoopDetector>()
/** Notes for the model, delivered on the next main-loop tool result. Never
 *  appended as their own rows mid-turn: a user row between a tool_use and
 *  its tool_result would break the request. */
const notes: string[] = []

// ---------- state helpers ----------

/** Mirror state to a file so the log can be read from outside the session. Never throws. */
async function mirrorState($: Eng) {
  try {
    const home = await $.env.get('USERPROFILE')
    if (!home) return
    const [run, policy, log] = [await read($, run$), await read($, policy$), await read($, log$)]
    await $.fs.write(
      `${home}/.claude/escalation-ladder/state.json`,
      JSON.stringify({ writtenAt: await $.clock.now(), run, policy, log }, null, 2),
    )
  } catch {
    /* best effort */
  }
}

async function logEvent($: Eng, ev: Omit<LadderEvent, 'at'>) {
  const at = await $.clock.now()
  await update($, log$, l => [...l, { ...ev, at }].slice(-80))
  await mirrorState($)
}

async function refreshStatus($: Eng) {
  const r = await read($, run$)
  const p = await read($, policy$)
  if (!r.enabled) return void $.ui.status(undefined)
  const t = p.tiers[r.tier]
  $.ui.status(
    `${r.isBroken ? 'STOPPED ' : ''}${t?.id ?? '?'} ${t?.model}/${t?.effort}${r.pinned ? ' pinned' : ''} esc ${r.escalations}/${p.maxEscalationsPerTask}`,
  )
}

async function addSpend($: Eng, key: string, u: Usage) {
  await update($, run$, r => {
    const s = r.spend[key] ?? { steps: 0, input: 0, output: 0, cacheRead: 0 }
    return {
      ...r,
      spend: {
        ...r.spend,
        [key]: {
          steps: s.steps + 1,
          input: s.input + (u?.input_tokens ?? 0),
          output: s.output + (u?.output_tokens ?? 0),
          cacheRead: s.cacheRead + (u?.cache_read_input_tokens ?? 0),
        },
      },
    }
  })
}

async function moveTier($: Eng, to: number, kind: 'escalate' | 'deescalate' | 'manual', reason: string) {
  const p = await read($, policy$)
  const from = (await read($, run$)).tier
  const next = Math.min(Math.max(to, 0), p.tiers.length - 1)
  if (next === from) return
  await update($, run$, r => ({
    ...r,
    tier: next,
    peakTier: Math.max(r.peakTier ?? 0, next),
    stepsOnTier: 0,
    cleanSteps: 0,
    errorStreak: 0,
    escalations: kind === 'escalate' ? r.escalations + 1 : r.escalations,
  }))
  await logEvent($, { kind, from, to: next, reason })
  if (kind === 'escalate') {
    notes.push(
      `[${NAME}] This task was escalated from ${label(p.tiers[from])} to ${label(p.tiers[next])}. Reason: ${reason}. ` +
        `Re-read what was tried; do not repeat an approach that already failed.`,
    )
    $.ui.toast(`Escalated to ${label(p.tiers[next])}: ${reason}`, { timeoutMs: 6000 })
  } else if (kind === 'deescalate') {
    $.ui.toast(`Stepped down to ${label(p.tiers[next])}`)
  }
  await refreshStatus($)
}

async function trip($: Eng, reason: string) {
  const r = await read($, run$)
  if (r.isBroken) return
  await update($, run$, x => ({ ...x, isBroken: true }))
  await logEvent($, { kind: 'breaker', reason })
  $.ui.toast(`Circuit breaker: ${reason}`, { timeoutMs: 10000 })
  $.ui.log(`${NAME}: stopped the task. ${reason}. Send a new prompt to continue (this resets the breaker).`)
  await refreshStatus($)
  if (r.turnId) {
    try {
      await $.turn.abort({ turnId: r.turnId } as never)
    } catch {
      /* the turn may already be over; tool.call denies keep it stopped */
    }
  }
}

/** One signal through the policy table, then act on the move. */
async function apply($: Eng, sig: Signal) {
  const run = await read($, run$)
  const p = await read($, policy$)
  const move = decide(sig, run, p)
  if (move.op === 'up') await moveTier($, move.to, 'escalate', move.reason)
  else if (move.op === 'trip') await trip($, move.reason)
  else await logEvent($, { kind: 'hold', reason: move.reason })
  return move
}

async function runReview($: Eng, scope: 'task' | 'milestone', note?: string): Promise<Verdict> {
  const p = await read($, policy$)
  const run = await read($, run$)
  const tier = p.tiers[pickReviewer(run.peakTier ?? run.tier, p)] ?? p.tiers[p.tiers.length - 1]!
  const rows = await $.session.messages()
  const r = await $.model.complete({
    model: tier.model,
    effort: tier.effort,
    system: REVIEW_SYSTEM,
    prompt: buildEvidence(rows.slice(-120) as never, scope, note),
    maxTokens: 800,
    timeoutMs: 90_000,
  })
  await addSpend($, `review:${tier.id}`, r.usage)
  if (!r.isAnswered) return { verdict: 'unsure', issues: [`reviewer unavailable (${r.reason})`] }
  return parseVerdict(r.text)
}

async function savePolicy($: Eng, p: Policy, resetTier = false) {
  const n = normalizePolicy(p)
  await update($, policy$, () => n)
  await $.store.set('policy', n)
  await update($, run$, r =>
    r.pinned ? r : { ...r, tier: resetTier ? n.baseTier : Math.min(r.tier, n.tiers.length - 1), stepsOnTier: 0, cleanSteps: 0 },
  )
  await refreshStatus($)
}

/** What a tap on the Button-only pane does. Same effects as the matching /ladder subcommands. */
async function doAction($: Eng, action: string, arg = '') {
  const p = await read($, policy$)
  const run = await read($, run$)
  if (action === 'up' || action === 'down') {
    await update($, run$, r => ({ ...r, pinned: true }))
    await moveTier($, run.tier + (action === 'up' ? 1 : -1), 'manual', 'manual')
  } else if (action === 'pin') {
    await update($, run$, r => ({ ...r, pinned: !r.pinned }))
  } else if (action === 'power') {
    await update($, run$, r => ({ ...r, enabled: !r.enabled }))
  } else if (action === 'reset') {
    detectors.clear()
    await update($, run$, r => ({ ...freshRun(p, r.enabled), spend: r.spend }))
  } else if (action === 'preset') {
    const preset = PRESETS[arg]
    if (preset) await savePolicy($, preset, true)
  } else if (action === 'step') {
    const [key = '', delta = '0'] = arg.split(':')
    const s = SETTINGS[key]
    if (s) {
      const r = applySet(p, key, String(Number(s.get(p)) + Number(delta)))
      if (r.ok) await savePolicy($, r.policy)
    }
  }
  await refreshStatus($)
}

/** Fail open: stop rewriting requests so the session falls back to its own model. */
async function failOpen($: Eng, why: string) {
  await update($, run$, r => ({ ...r, enabled: false }))
  await logEvent($, { kind: 'breaker', reason: `ladder turned off: ${why}` })
  $.ui.toast(`Ladder turned off: ${why}`, { timeoutMs: 15000 })
  $.ui.log(`${NAME}: turned off (${why}). Your session model is unchanged; fix the tier and run /ladder on.`)
  await refreshStatus($)
}

/** One tiny completion per distinct model+effort; resolves who is usable before we rewrite real requests. */
async function probeTiers($: Eng): Promise<string[]> {
  const p = await read($, policy$)
  const bad: string[] = []
  const seen = new Set<string>()
  for (const t of p.tiers) {
    if (seen.has(t.model)) continue
    seen.add(t.model)
    const r = await $.model.complete({ model: t.model, effort: 'low', prompt: 'Reply with the single word ok', maxTokens: 16, timeoutMs: 30_000 })
    if (!r.isAnswered) bad.push(`${t.model} (${t.id}): ${r.reason}`)
  }
  return bad
}

function openPane($: Eng) {
  return $.ui.open({ id: PANE, title: 'Model ladder', focus: true, closeOnEscape: true })
}


export const register: Register = on => {
  // ---------- lifecycle ----------

  on('session.start', async ($, e, next) => {
    const stored = await $.store.get('policy')
    const policy = normalizePolicy(stored ?? PRESETS[DEFAULT_PRESET])

    // Test infrastructure: allow mocking startsNewTask to preserve pin across prompts (issue #9 check #2)
    if (typeof process !== 'undefined' && process.env.LADDER_TEST_MODE === 'true') {
      setTestModeStartsNewTask(originKind => originKind !== 'bridge')
      await logEvent($, { kind: 'config', reason: 'LADDER_TEST_MODE enabled: pin preserved across bridge origins' })
    }

    await update($, policy$, () => policy)
    const cur = await read($, run$)
    // A hot reload re-runs session.start. Keep the task (pin, breaker, turnId,
    // budgets) and only re-fit the tier to the possibly changed policy; the task
    // resets on the next user prompt, not on a code edit. Fields added by newer
    // versions come from freshRun so an older stored run still works.
    const top = policy.tiers.length - 1
    await update($, run$, () => ({
      ...freshRun(policy, cur.enabled),
      ...cur,
      tier: Math.min(Math.max(cur.tier ?? policy.baseTier, 0), top),
      peakTier: Math.min(Math.max(cur.peakTier ?? cur.tier ?? policy.baseTier, 0), top),
    }))
    await logEvent($, {
      kind: 'reload',
      reason: `session.start: kept task state (pinned=${cur.pinned}, broken=${cur.isBroken}, tier=${cur.tier})`,
    })

    await $.command.register({
      name: 'ladder',
      description: 'Model escalation ladder: pane, on/off, up/down, pin, preset <name>, reset',
      argumentHint: '[status|help|on|off|probe|log|up|down|pin|unpin|reset|preset <name>|get|set <key> <value>|tier <n> <model> <effort>]',
    })

    await $.tool.register({
      name: 'request_escalation',
      description:
        'Ask the harness to continue this task on a stronger model. Call it when you are genuinely unsure you can finish correctly ' +
        'at your current capability, are going in circles, or the decision is high-stakes or needs deeper reasoning. ' +
        'Be honest: report your real confidence (0..1) that you can complete the NEXT part correctly. Cheap to call; do not push on while stuck.',
      inputSchema: {
        type: 'object',
        properties: {
          confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Your confidence you can do the next part correctly.' },
          ask: { type: 'string', enum: ['stuck', 'deeper-reasoning', 'high-stakes'] },
          reason: { type: 'string', description: 'One or two sentences: what is hard here.' },
        },
        required: ['confidence', 'ask', 'reason'],
      },
    })
    await $.tool.register({
      name: 'consult_oracle',
      description:
        'Ask the oracle-tier model one focused question and get its answer back as this tool result, without switching the whole ' +
        'task to the expensive model. Use for a single hard judgment (design choice, subtle bug diagnosis). Include what you tried.',
      inputSchema: {
        type: 'object',
        properties: { question: { type: 'string' } },
        required: ['question'],
      },
    })
    await $.tool.register({
      name: 'checkpoint',
      description:
        'Mark a milestone as complete (after finishing a meaningful step of the plan). When milestone review is on, an independent ' +
        'reviewer checks the work so far and its verdict is returned here. Summarise what was done and how you verified it.',
      inputSchema: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      },
    })

    await refreshStatus($)
    await mirrorState($)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // Only a new request starts a task; a review follow-up, subagent hand-back or
    // background-task notification continues the task in flight.
    if (startsNewTask(e.origin.kind)) {
      const p = await read($, policy$)
      detectors.clear()
      notes.length = 0
      await update($, run$, r => ({
        ...freshRun(p, r.enabled),
        pinned: r.pinned,
        tier: r.pinned ? r.tier : p.baseTier,
        spend: r.spend,
      }))
      await logEvent($, { kind: 'reset', reason: 'new user prompt' })
      await refreshStatus($)
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await update($, run$, r => ({ ...r, turnId: e.turnId }))
    return next(e)
  })

  // ---------- the escalation lever: model + effort per request ----------

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    const run = await read($, run$)
    if (!run.enabled) return yield* next(e)

    const p = await read($, policy$)
    if (run.isBroken) {
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
    }
    const tier = p.tiers[run.tier] ?? p.tiers[0]!
    let res
    try {
      res = yield* next({ ...e, model: tier.model, effort: tier.effort })
      // [issue #9 check 3] Log advisor calls for visibility testing
      const advisorUses = res.toolUses?.filter((u: { name: string }) => u.name === 'advisor') ?? []
      if (advisorUses.length > 0) {
        await logEvent($, {
          kind: 'tool',
          reason: `advisor call(s) at tier ${run.tier} (${tier.model}): ${advisorUses.length} use(s)`,
        })
      }
    } catch (err) {
      await failOpen($, `request on ${tier.model} failed`)
      throw err
    }
    if (res.stopReason === null && !res.usage) {
      // No response arrived on a model we chose: assume the choice was refused.
      await failOpen($, `${tier.model} (${tier.id}) was rejected`)
      return res
    }

    await addSpend($, tier.id, res.usage)
    // A tool in this step (request_escalation, a loop hit) may already have moved
    // the rung while the response was still streaming. Such a step ran on the old
    // rung, so it must not count toward the new rung's budget or cooldown.
    const movedDuringStep = (await read($, run$)).tier !== run.tier
    await update($, run$, r => ({
      ...r,
      stepsInTask: r.stepsInTask + 1,
      // The step ran on `run.tier`, however the rung got there (a pin or /ladder pane included).
      peakTier: peakAfter(r.peakTier, run.tier),
      ...(movedDuringStep
        ? {}
        : {
            stepsOnTier: r.stepsOnTier + 1,
            cleanSteps: r.errorStreak === 0 ? r.cleanSteps + 1 : 0,
          }),
    }))
    const after = await read($, run$)

    if (movedDuringStep && after.stepsInTask < p.maxStepsPerTask) {
      await refreshStatus($)
    } else if (after.stepsInTask >= p.maxStepsPerTask) {
      await trip($, `step budget for the whole task (${p.maxStepsPerTask}) reached`)
    } else if (res.stopReason === 'max_tokens') {
      await apply($, { kind: 'truncated' })
    } else if (res.stopReason === 'refusal') {
      await apply($, { kind: 'refusal' })
    } else if (after.stepsOnTier >= p.maxStepsPerTier && after.tier < p.tiers.length - 1) {
      await apply($, { kind: 'step-budget', steps: after.stepsOnTier })
    } else if (shouldStepDown(after, p)) {
      await moveTier($, after.tier - 1, 'deescalate', `${after.cleanSteps} clean steps`)
    } else {
      await refreshStatus($)
    }
    return res
  })

  // ---------- loop detection, error streaks, breaker enforcement ----------

  on('tool.call', async ($, e, next) => {
    if (e.tool.startsWith('mcp__escalation-ladder__')) return next(e)
    const run = await read($, run$)
    if (!run.enabled) return next(e)
    const isMain = e.agentId === undefined

    if (isMain && run.isBroken) {
      return {
        deny: `${NAME}: the circuit breaker stopped this task (${run.lastLoop ?? 'budget exhausted'}). Do not retry; tell the user what is blocking you.`,
      }
    }

    const ran = await next(e)
    if (ran.deny !== undefined) return ran

    const p = await read($, policy$)
    const key = e.agentId ?? 'main'
    const det = detectors.get(key) ?? new LoopDetector()
    detectors.set(key, det)
    const text = ran.text ?? ''
    const isError = ran.isError === true
    det.push({
      sig: signature(e.tool, e as unknown as Record<string, unknown>),
      resultHash: hash(text.slice(0, 2000)),
      isError,
      errKey: errorKey(text),
    })

    const out: string[] = []
    const hit = det.check(p.loop)

    if (isMain) {
      await update($, run$, r => ({
        ...r,
        toolCallsInTask: r.toolCallsInTask + 1,
        errorStreak: isError ? r.errorStreak + 1 : 0,
      }))
    }

    if (hit) {
      det.clear()
      const warn = `Loop detected (${hit.detail}). Stop repeating this; choose a materially different approach or report that you are blocked.`
      out.push(`[${NAME}] ${warn}`)
      if (isMain) {
        await update($, run$, r => ({ ...r, loopStrikes: r.loopStrikes + 1, lastLoop: hit.detail }))
        await logEvent($, { kind: 'loop', reason: `${hit.kind}: ${hit.detail} (${e.tool})` })
        const strikes = (await read($, run$)).loopStrikes
        if (strikes >= 3) await trip($, `${strikes} loops in one task despite escalation`)
        else await apply($, { kind: 'loop', detail: `${hit.kind}, ${hit.detail}` })
      }
    } else if (isMain) {
      const r = await read($, run$)
      if (r.errorStreak >= p.errorStreak) {
        await apply($, { kind: 'error-streak', n: r.errorStreak })
        await update($, run$, x => ({ ...x, errorStreak: 0 }))
      }
    }

    if (isMain && notes.length) out.push(...notes.splice(0))
    return out.length ? { ...ran, context: [...(ran.context ?? []), ...out] } : ran
  })

  // ---------- tools the model can call ----------

  on('tool.call', { tool: 'mcp__escalation-ladder__request_escalation' }, async ($, e) => {
    const a = e as unknown as { confidence?: number; ask?: string; reason?: string }
    const ask = a.ask === 'deeper-reasoning' || a.ask === 'high-stakes' ? a.ask : 'stuck'
    await update($, run$, r => ({ ...r, escalationRequests: (r.escalationRequests ?? 0) + 1 }))
    const move = await apply($, {
      kind: 'model-request',
      confidence: typeof a.confidence === 'number' ? a.confidence : 0,
      ask,
      reason: String(a.reason ?? '').slice(0, 300),
    })
    const p = await read($, policy$)
    const run = await read($, run$)
    if (move.op === 'up') {
      return { result: `Escalation granted: later steps run on ${label(p.tiers[move.to])}. Continue the task.` }
    }
    return { result: `No escalation (${move.reason}); still on ${label(p.tiers[run.tier])}. Continue.` }
  })

  on('tool.call', { tool: 'mcp__escalation-ladder__consult_oracle' }, async ($, e) => {
    const q = String((e as unknown as { question?: string }).question ?? '')
    await update($, run$, r => ({ ...r, consults: (r.consults ?? 0) + 1 }))
    const p = await read($, policy$)
    const tier = p.tiers[p.tiers.length - 1]!
    const rows = await $.session.messages()
    const r = await $.model.complete({
      model: tier.model,
      effort: tier.effort,
      system:
        'You are a senior engineer consulted by a colleague mid-task. Answer the question directly and concretely: the decision, the reason, and the first thing to do. No preamble.',
      prompt: `${buildEvidence(rows.slice(-80) as never, 'task', 'for context only')}\n\nQUESTION:\n${q}`,
      maxTokens: 2000,
      timeoutMs: 120_000,
    })
    await addSpend($, `consult:${tier.id}`, r.usage)
    await logEvent($, { kind: 'escalate', reason: `consulted oracle: ${q.slice(0, 80)}` })
    return { result: r.isAnswered ? r.text : `The oracle was unavailable (${r.reason}). Proceed on your own judgment.` }
  })

  on('tool.call', { tool: 'mcp__escalation-ladder__checkpoint' }, async ($, e) => {
    const summary = String((e as unknown as { summary?: string }).summary ?? '')
    const p = await read($, policy$)
    await logEvent($, { kind: 'milestone', reason: summary.slice(0, 120) })
    if (p.review.mode !== 'milestone' && p.review.mode !== 'both') {
      return { result: 'Checkpoint recorded (milestone review is off).' }
    }
    const v = await runReview($, 'milestone', summary)
    await logEvent($, { kind: 'review', reason: `milestone ${v.verdict}${v.issues.length ? `: ${v.issues[0]}` : ''}` })
    if (v.verdict === 'fail') {
      await apply($, { kind: 'review-failed', issues: v.issues.join('; ') })
    }
    return {
      result:
        v.verdict === 'pass'
          ? 'Milestone review: PASS. Continue to the next step.'
          : `Milestone review: ${v.verdict.toUpperCase()}.\n${v.issues.map(i => `- ${i}`).join('\n')}\nAddress these before moving on.`,
    }
  })

  // ---------- advisor steering (issue #9 point 5) ----------
  // Executors under-call the native advisor on coding tasks; one session-scoped
  // section nudges the consult moments. Only while the ladder is on, so an off
  // ladder leaves the system prompt (and its cache) untouched.
  on('prompt.compose', async ($, e, next) => {
    const base = await next(e)
    const run = await read($, run$)
    if (!run.enabled || !e.tools.includes('advisor')) return base
    return {
      sections: [
        ...base.sections,
        {
          id: 'escalation-ladder:advisor',
          scope: 'session',
          text: [
            '# Advisor',
            'You have an `advisor` tool. Call it before committing to an approach on any non-trivial task,',
            'once more when you believe the work is done (after saving it), and when you are stuck,',
            'errors recur, or you are about to change approach. Skip it for short, reactive steps.',
          ].join('\n'),
        },
      ],
    }
  })

  // ---------- task-level validation pass ----------

  on('turn.complete', async ($, e, next) => {
    const base = await next(e)
    if (e.agentId || e.reason !== 'answer') return base
    const run = await read($, run$)
    const p = await read($, policy$)
    const wants = p.review.mode === 'task' || p.review.mode === 'both'
    if (!run.enabled || !wants || run.isBroken) return base
    if (run.toolCallsInTask < p.review.minToolCalls) return base
    if (run.reviewRounds >= p.review.maxRounds) return base
    // Nothing was done since the last review (the model just answered the rejection in words).
    if (run.toolCallsInTask <= (run.reviewedToolCalls ?? 0)) return base

    const lastRound = run.reviewRounds + 1 >= p.review.maxRounds
    await update($, run$, r => ({ ...r, reviewRounds: r.reviewRounds + 1, reviewedToolCalls: r.toolCallsInTask }))
    const v = await runReview($, 'task')
    await logEvent($, { kind: 'review', reason: `task ${v.verdict}${v.issues.length ? `: ${v.issues[0]}` : ''}` })

    if (v.verdict === 'fail') {
      await apply($, { kind: 'review-failed', issues: v.issues.join('; ') })
      // On the last allowed round a rework could never be reviewed, so report the failure instead of looping on it.
      if (lastRound) return { ...base, text: `${base.text}\n\nReview: FAIL (final round, not resubmitted): ${v.issues.join('; ')}` }
      void $.prompt.submit({
        text:
          `[${NAME}] An independent reviewer rejected your last answer:\n${v.issues.map(i => `- ${i}`).join('\n')}\n` +
          `Fix what is wrong (verify with a real check this time), then give a corrected answer.`,
      })
      return { ...base, text: `${base.text}\n\nReview: FAIL. Sent back for another pass.` }
    }
    return { ...base, text: `${base.text}\n\nReview: ${v.verdict.toUpperCase()}.` }
  })

  // ---------- /ladder and the pane ----------

  on('command.run', { command: 'ladder' }, async ($, e) => {
    const [cmd = '', arg = '', arg2, arg3] = e.args.trim().split(/\s+/)
    const run = await read($, run$)
    const p = await read($, policy$)
    switch (cmd) {
      case '':
        // A phone or web client (bridge) may not draw the pane, so answer in text it always renders.
        if (e.origin.kind === 'bridge') return { text: `${formatStatus(run, p)}\n\n${HELP}\n\n(/ladder pane tries the tap-to-control pane.)` }
        await openPane($)
        return { text: 'Ladder pane opened. (/ladder status or /ladder help for text.)' }
      case 'pane':
        await openPane($)
        return { text: `Pane requested from ${e.origin.kind}. If nothing appears on this device, use /ladder status and the text commands.` }
      case 'status':
        return { text: formatStatus(run, p) }
      case 'help':
      case '--help':
      case '-h':
      case '?':
        return { text: HELP }
      case 'get':
        return { text: listSettings(p) }
      case 'set': {
        const r = applySet(p, arg, arg2)
        if (!r.ok) return { text: r.error }
        await savePolicy($, r.policy, arg === 'baseTier')
        return { text: `Set ${r.note}` }
      }
      case 'tier': {
        if (arg === '') return { text: listTiers(p, run) }
        const r = applyTier(p, arg, arg2, arg3)
        if (!r.ok) return { text: r.error }
        await savePolicy($, r.policy)
        return { text: `Set ${r.note}` }
      }
      case 'on': {
        const bad = await probeTiers($)
        if (bad.length) return { text: `Not turned on; these tiers are unusable:\n${bad.map(b => `- ${b}`).join('\n')}\nFix them in the pane (/ladder), then retry.` }
        await update($, run$, r => ({ ...r, enabled: true }))
        await refreshStatus($)
        return { text: 'Ladder on. All tiers answered a probe.' }
      }
      case 'probe': {
        const bad = await probeTiers($)
        return { text: bad.length ? `Unusable:\n${bad.map(b => `- ${b}`).join('\n')}` : 'All tiers answered a probe.' }
      }
      case 'log': {
        const events = await read($, log$)
        const r = await read($, run$)
        if (events.length === 0) return { text: 'No events yet.' }
        let prevDay = ''
        const lines = events.map(ev => {
          // Times are UTC. Show the date when the day changes so a long session reads in order.
          const iso = new Date(ev.at).toISOString()
          const day = iso.slice(0, 10)
          const time = (day === prevDay ? '' : `${day} `) + iso.slice(11, 19)
          prevDay = day
          const from = ev.from !== undefined && ev.to !== undefined ? `${ev.from}→${ev.to} ` : ''
          return `${time} ${ev.kind.padEnd(10)} ${from}${ev.reason}`
        })
        return { text: `Task status: ${r.isBroken ? 'STOPPED' : r.enabled ? 'on' : 'off'}, tier ${r.tier}/${p.tiers.length - 1}, escalations ${r.escalations}/${p.maxEscalationsPerTask}\n\nRecent events:\n${lines.join('\n')}` }
      }
      case 'off':
        await update($, run$, r => ({ ...r, enabled: false }))
        await refreshStatus($)
        return { text: 'Ladder off.' }
      case 'up':
        await update($, run$, r => ({ ...r, pinned: true }))
        await moveTier($, run.tier + 1, 'manual', 'manual')
        return { text: `Pinned at ${label(p.tiers[Math.min(run.tier + 1, p.tiers.length - 1)])}.` }
      case 'down':
        await update($, run$, r => ({ ...r, pinned: true }))
        await moveTier($, run.tier - 1, 'manual', 'manual')
        return { text: `Pinned at ${label(p.tiers[Math.max(run.tier - 1, 0)])}.` }
      case 'pin':
      case 'unpin':
        await update($, run$, r => ({ ...r, pinned: cmd === 'pin' }))
        await refreshStatus($)
        return { text: cmd === 'pin' ? 'Tier pinned; escalation is observe-only.' : 'Tier unpinned.' }
      case 'reset':
        await update($, run$, r => ({ ...freshRun(p, r.enabled), spend: r.spend }))
        detectors.clear()
        await refreshStatus($)
        return { text: 'Task counters and breaker reset.' }
      case 'preset': {
        const preset = PRESETS[arg]
        if (!preset) return { text: `Unknown preset. Use: ${Object.keys(PRESETS).join(', ')}` }
        await savePolicy($, preset, true)
        return { text: `Preset ${arg} applied.` }
      }
      default:
        return { text: `Unknown subcommand "${cmd}".\n\n${HELP}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const run = await read($, run$)
    const p = await read($, policy$)
    const log = await read($, log$)

    if (e.surface === 'mobile') {
      // No text fields or selects on mobile: taps and -/+ steppers instead; anything else via /ladder.
      const m = $.ui.resolve(e)
      const state = !run.enabled ? 'OFF' : run.isBroken ? 'STOPPED (breaker)' : run.pinned ? 'pinned' : 'auto'
      return (
        <m.Box flexDirection="column" gap={1}>
          <m.Text bold>
            Ladder {state}: {label(p.tiers[run.tier])}
          </m.Text>
          <m.Svg
            source={gaugeSvg(p, run)}
            alt={`Rung ${run.tier} of ${p.tiers.length - 1}: ${p.tiers[run.tier]?.id ?? '?'}`}
            width={320}
          />
          <m.Text>
            task {run.stepsInTask}/{p.maxStepsPerTask} steps, esc {run.escalations}/{p.maxEscalationsPerTask}, loops {run.loopStrikes}/3, review {run.reviewRounds}/{p.review.maxRounds}
          </m.Text>
          <m.Box gap={1}>
            <m.Button key="m-up" label="Up" onPress={() => { void doAction($, 'up') }} />
            <m.Button key="m-down" label="Down" onPress={() => { void doAction($, 'down') }} />
            <m.Button key="m-pin" label={run.pinned ? 'Unpin' : 'Pin'} onPress={() => { void doAction($, 'pin') }} />
            <m.Button key="m-power" label={run.enabled ? 'Turn off' : 'Turn on'} onPress={() => { void doAction($, 'power') }} />
            <m.Button key="m-reset" label="Reset" onPress={() => { void doAction($, 'reset') }} />
          </m.Box>
          <m.Box gap={1}>
            <m.Button key="m-p-frugal" label="Frugal" onPress={() => { void doAction($, 'preset', 'frugal') }} />
            <m.Button key="m-p-balanced" label="Balanced" onPress={() => { void doAction($, 'preset', 'balanced') }} />
            <m.Button key="m-p-cautious" label="Cautious" onPress={() => { void doAction($, 'preset', 'cautious') }} />
          </m.Box>
          {STEPPERS.map(st => (
            <m.Box key={`s-${st.key}`} gap={1}>
              <m.Button key={`s-${st.key}-minus`} label="-" onPress={() => { void doAction($, 'step', `${st.key}:${-st.step}`) }} />
              <m.Button key={`s-${st.key}-plus`} label="+" onPress={() => { void doAction($, 'step', `${st.key}:${st.step}`) }} />
              <m.Text>
                {st.key} = {String(SETTINGS[st.key]!.get(p))}
              </m.Text>
            </m.Box>
          ))}
          <m.Text dimColor>Recent events</m.Text>
          {log.slice(-6).map((ev, i) => (
            <m.Text key={`ev${i}`} dimColor>
              {new Date(ev.at).toISOString().slice(5, 16).replace('T', ' ')} {ev.kind}: {ev.reason.slice(0, 80)}
            </m.Text>
          ))}
          <m.Text dimColor>Rungs and other settings: /ladder tier, /ladder set, /ladder help</m.Text>
        </m.Box>
      )
    }
    const { Box, Text, Button, Input, Select } = $.ui.resolve(e)

    const setNum = (pick: (x: Policy, v: number) => Policy) => (v: string) => {
      const n = Number(v)
      if (Number.isFinite(n)) void savePolicy($, pick(p, n))
    }
    const setTier = (i: number, patch: Partial<Tier>) =>
      savePolicy($, { ...p, tiers: p.tiers.map((t, j) => (j === i ? { ...t, ...patch } : t)) })
    const tierOptions = p.tiers.map((t, i) => ({ value: String(i), label: `${i} ${t.id}` }))

    const status = !run.enabled ? 'OFF' : run.isBroken ? 'STOPPED (breaker)' : run.pinned ? 'pinned' : 'auto'

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>
            Ladder: {status}   task: {run.stepsInTask}/{p.maxStepsPerTask} steps, {run.escalations}/{p.maxEscalationsPerTask} escalations, {run.loopStrikes} loop strikes, {run.reviewRounds}/{p.review.maxRounds} review rounds
          </Text>
          {[...p.tiers.keys()].reverse().map(i => {
            const t = p.tiers[i]!
            const s = run.spend[t.id]
            const isNow = i === run.tier
            return (
              <Text key={`t${i}`} bold={isNow} color={isNow ? 'green' : undefined} dimColor={!isNow}>
                {isNow ? '>' : ' '} {i} {t.id.padEnd(7)} {t.model}/{t.effort}{i === p.baseTier ? '  [base]' : ''}{s ? `  ${s.steps} steps, ${s.input}in/${s.output}out, ${s.cacheRead} cached` : ''}
              </Text>
            )
          })}
        </Box>

        <Box gap={1}>
          <Button key="up" label="Up" hotkey="u" onPress={() => { void update($, run$, r => ({ ...r, pinned: true })).then(() => moveTier($, run.tier + 1, 'manual', 'manual')) }} />
          <Button key="down" label="Down" hotkey="d" onPress={() => { void update($, run$, r => ({ ...r, pinned: true })).then(() => moveTier($, run.tier - 1, 'manual', 'manual')) }} />
          <Button key="pin" label={run.pinned ? 'Unpin' : 'Pin'} hotkey="p" onPress={() => { void update($, run$, r => ({ ...r, pinned: !r.pinned })).then(() => refreshStatus($)) }} />
          <Button key="onoff" label={run.enabled ? 'Turn off' : 'Turn on'} hotkey="o" onPress={() => { void update($, run$, r => ({ ...r, enabled: !r.enabled })).then(() => refreshStatus($)) }} />
          <Button key="reset" label="Reset task" hotkey="r" onPress={() => { detectors.clear(); void update($, run$, r => ({ ...freshRun(p, r.enabled), spend: r.spend })).then(() => refreshStatus($)) }} />
        </Box>

        <Box flexDirection="column">
          <Text bold>Policy</Text>
          <Select key="preset" label="Preset (replaces all)" value="" options={[{ value: '', label: '(choose)' }, ...Object.keys(PRESETS).map(k => ({ value: k, label: k }))]} onSelect={v => { const x = PRESETS[v]; if (x) void savePolicy($, x, true) }} />
          <Select key="base" label="Base tier" value={String(p.baseTier)} options={tierOptions} onSelect={v => void savePolicy($, { ...p, baseTier: Number(v) }, true)} />
          <Input key="conf" label="Escalate below confidence" value={String(p.confidenceThreshold)} onSubmit={setNum((x, n) => ({ ...x, confidenceThreshold: n }))} />
          <Input key="steps" label="Steps per tier before stall-escalate" value={String(p.maxStepsPerTier)} onSubmit={setNum((x, n) => ({ ...x, maxStepsPerTier: n }))} />
          <Input key="err" label="Tool-error streak to escalate" value={String(p.errorStreak)} onSubmit={setNum((x, n) => ({ ...x, errorStreak: n }))} />
          <Input key="cool" label="Clean steps before step-down" value={String(p.cooldownSteps)} onSubmit={setNum((x, n) => ({ ...x, cooldownSteps: n }))} />
          <Input key="maxesc" label="Max escalations per task" value={String(p.maxEscalationsPerTask)} onSubmit={setNum((x, n) => ({ ...x, maxEscalationsPerTask: n }))} />
          <Input key="maxsteps" label="Breaker: max steps per task" value={String(p.maxStepsPerTask)} onSubmit={setNum((x, n) => ({ ...x, maxStepsPerTask: n }))} />
          <Input key="lrep" label="Loop: identical call+result x" value={String(p.loop.repeat)} onSubmit={setNum((x, n) => ({ ...x, loop: { ...x.loop, repeat: n } }))} />
          <Input key="lping" label="Loop: A/B alternation x" value={String(p.loop.pingPong)} onSubmit={setNum((x, n) => ({ ...x, loop: { ...x.loop, pingPong: n } }))} />
          <Input key="lerr" label="Loop: same error x" value={String(p.loop.sameError)} onSubmit={setNum((x, n) => ({ ...x, loop: { ...x.loop, sameError: n } }))} />
        </Box>

        <Box flexDirection="column">
          <Text bold>Review</Text>
          <Select key="rmode" label="Mode" value={p.review.mode} options={['off', 'task', 'milestone', 'both'].map(m => ({ value: m, label: m }))} onSelect={v => void savePolicy($, { ...p, review: { ...p.review, mode: v as Policy['review']['mode'] } })} />
          <Select key="rtier" label="Reviewer tier" value={String(p.review.reviewerTier)} options={tierOptions} onSelect={v => void savePolicy($, { ...p, review: { ...p.review, reviewerTier: Number(v) } })} />
          <Input key="rmin" label="Min tool calls to review a task" value={String(p.review.minToolCalls)} onSubmit={setNum((x, n) => ({ ...x, review: { ...x.review, minToolCalls: n } }))} />
          <Input key="rmax" label="Max review rounds" value={String(p.review.maxRounds)} onSubmit={setNum((x, n) => ({ ...x, review: { ...x.review, maxRounds: n } }))} />
        </Box>

        <Box flexDirection="column">
          <Text bold>Tiers</Text>
          {p.tiers.map((t, i) => (
            <Box key={`tr${i}`} gap={1}>
              <Input key={`tm${i}`} label={`${i} ${t.id} model`} value={t.model} onSubmit={v => void setTier(i, { model: v.trim() || t.model })} />
              <Select key={`te${i}`} label="effort" value={t.effort} options={EFFORTS.map(x => ({ value: x, label: x }))} onSelect={v => void setTier(i, { effort: v as Effort })} />
            </Box>
          ))}
        </Box>

        <Box flexDirection="column">
          <Text bold>Recent events</Text>
          {log.length === 0 && <Text dimColor>None yet.</Text>}
          {log.slice(-Math.max(5, (e.viewport?.rows ?? 40) - 40)).reverse().map((ev, i) => (
            <Text key={`ev${i}`} dimColor={ev.kind === 'hold'} color={ev.kind === 'breaker' ? 'red' : ev.kind === 'escalate' ? 'yellow' : undefined}>
              {ev.kind.padEnd(10)} {ev.from !== undefined && ev.to !== undefined ? `${ev.from}>${ev.to} ` : ''}{ev.reason}
            </Text>
          ))}
        </Box>
      </Box>
    )
  })
}
