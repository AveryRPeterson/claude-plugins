import type { Effort, Policy, RunState } from '../../types'
import { normalizePolicy, resolveModel } from './policy'

/**
 * Text-only control surface for /ladder. Command output is plain text, so it
 * renders on every surface (terminal, desktop, VS Code, the phone) even where
 * the pane or its fields do not. Pure: no engine calls, unit-tested.
 */

export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export const HELP = [
  'Ladder commands',
  '/ladder            status (remote) or the pane (terminal/desktop)',
  '/ladder status     tier, task counters, spend',
  '/ladder on | off   enable (probes every tier first) | disable',
  '/ladder probe      check every tier answers',
  '/ladder log        recent events',
  '/ladder up | down  move one rung and pin there',
  '/ladder pin | unpin   freeze / release the rung',
  '/ladder reset      clear task counters, breaker and pin',
  '/ladder preset <frugal|balanced|cautious>',
  '/ladder get        list settings and their values',
  '/ladder set <key> <value>   change a setting (see get)',
  '/ladder tier       list rungs',
  '/ladder tier <n> <model> <effort>   edit a rung, then /ladder probe',
].join('\n')

type Setting = {
  get: (p: Policy) => number | string
  set: (p: Policy, v: number | string) => Policy
  kind: 'int' | 'frac' | 'enum'
  help: string
  options?: string[]
}

const num = (n: unknown) => (typeof n === 'number' ? n : NaN)

export const SETTINGS: Record<string, Setting> = {
  baseTier: { kind: 'int', help: 'rung a task starts on', get: p => p.baseTier, set: (p, v) => ({ ...p, baseTier: num(v) }) },
  confidence: { kind: 'frac', help: 'self-reported confidence below this escalates (0-1)', get: p => p.confidenceThreshold, set: (p, v) => ({ ...p, confidenceThreshold: num(v) }) },
  stepsPerTier: { kind: 'int', help: 'steps on a rung before a stall escalation', get: p => p.maxStepsPerTier, set: (p, v) => ({ ...p, maxStepsPerTier: num(v) }) },
  errorStreak: { kind: 'int', help: 'consecutive tool errors before escalating', get: p => p.errorStreak, set: (p, v) => ({ ...p, errorStreak: num(v) }) },
  cooldown: { kind: 'int', help: 'clean steps before stepping down a rung', get: p => p.cooldownSteps, set: (p, v) => ({ ...p, cooldownSteps: num(v) }) },
  maxEscalations: { kind: 'int', help: 'escalations allowed per task', get: p => p.maxEscalationsPerTask, set: (p, v) => ({ ...p, maxEscalationsPerTask: num(v) }) },
  maxSteps: { kind: 'int', help: 'hard step cap per task', get: p => p.maxStepsPerTask, set: (p, v) => ({ ...p, maxStepsPerTask: num(v) }) },
  loopRepeat: { kind: 'int', help: 'identical call+result repeats that count as a loop', get: p => p.loop.repeat, set: (p, v) => ({ ...p, loop: { ...p.loop, repeat: num(v) } }) },
  loopPingPong: { kind: 'int', help: 'A/B alternations that count as a loop (max 12)', get: p => p.loop.pingPong, set: (p, v) => ({ ...p, loop: { ...p.loop, pingPong: num(v) } }) },
  loopSameError: { kind: 'int', help: 'same error in a row that counts as a loop', get: p => p.loop.sameError, set: (p, v) => ({ ...p, loop: { ...p.loop, sameError: num(v) } }) },
  reviewMode: { kind: 'enum', options: ['off', 'task', 'milestone', 'both'], help: 'when the independent reviewer runs', get: p => p.review.mode, set: (p, v) => ({ ...p, review: { ...p.review, mode: v as Policy['review']['mode'] } }) },
  reviewerTier: { kind: 'int', help: 'lowest rung allowed to review', get: p => p.review.reviewerTier, set: (p, v) => ({ ...p, review: { ...p.review, reviewerTier: num(v) } }) },
  reviewMinCalls: { kind: 'int', help: 'tool calls a task needs before it is reviewed', get: p => p.review.minToolCalls, set: (p, v) => ({ ...p, review: { ...p.review, minToolCalls: num(v) } }) },
  reviewRounds: { kind: 'int', help: 'review-then-fix rounds per task', get: p => p.review.maxRounds, set: (p, v) => ({ ...p, review: { ...p.review, maxRounds: num(v) } }) },
}

export type Edit = { ok: true; policy: Policy; note: string } | { ok: false; error: string }

export function listSettings(p: Policy): string {
  const rows = Object.entries(SETTINGS).map(([k, s]) => `${k} = ${s.get(p)}  (${s.help}${s.options ? `: ${s.options.join('|')}` : ''})`)
  return ['Settings (use /ladder set <key> <value>)', ...rows].join('\n')
}

export function applySet(p: Policy, key: string, value: string | undefined): Edit {
  const s = SETTINGS[key]
  if (!s) return { ok: false, error: `Unknown setting "${key}". /ladder get lists them.` }
  if (value === undefined || value === '') return { ok: false, error: `Usage: /ladder set ${key} <value>` }
  let v: number | string
  if (s.kind === 'enum') {
    if (!s.options!.includes(value)) return { ok: false, error: `${key} must be one of: ${s.options!.join(', ')}` }
    v = value
  } else {
    v = Number(value)
    if (value.trim() === '' || !Number.isFinite(v)) return { ok: false, error: `${key} needs a number, got "${value}".` }
  }
  const next = normalizePolicy(s.set(p, v))
  const stored = s.get(next)
  const clamped = s.kind !== 'enum' && stored !== v
  return { ok: true, policy: next, note: `${key} = ${stored}${clamped ? ` (clamped from ${v})` : ''}` }
}

export function listTiers(p: Policy, run?: RunState): string {
  return [
    'Rungs (cheapest first, last = oracle)',
    ...p.tiers.map((t, i) => `${i}${run && run.tier === i ? '*' : ' '} ${t.id}  ${t.model}  ${t.effort}`),
  ].join('\n')
}

export function applyTier(p: Policy, idx: string | undefined, model: string | undefined, effort: string | undefined): Edit {
  const i = Number(idx)
  if (idx === undefined || !Number.isInteger(i) || i < 0 || i >= p.tiers.length) {
    return { ok: false, error: `Rung must be 0-${p.tiers.length - 1}. Usage: /ladder tier <n> <model> <effort>` }
  }
  if (!model) return { ok: false, error: 'Usage: /ladder tier <n> <model> <effort>  (model: haiku|sonnet|opus or a full id)' }
  if (!effort || !EFFORTS.includes(effort as Effort)) return { ok: false, error: `Effort must be one of: ${EFFORTS.join(', ')}` }
  const tiers = p.tiers.map((t, j) => (j === i ? { ...t, model: resolveModel(model), effort: effort as Effort } : t))
  const next = normalizePolicy({ ...p, tiers })
  const t = next.tiers[i]!
  return { ok: true, policy: next, note: `rung ${i} (${t.id}) = ${t.model} / ${t.effort}. Run /ladder probe to check it answers.` }
}

const bar = (n: number, of: number) => `${n}/${of}`

export function formatStatus(run: RunState, p: Policy): string {
  const t = p.tiers[run.tier]
  const state = !run.enabled ? 'OFF' : run.isBroken ? 'STOPPED (breaker)' : run.pinned ? 'ON, pinned' : 'ON, auto'
  const lines = [
    `Ladder: ${state}`,
    `Rung ${run.tier}/${p.tiers.length - 1}: ${t ? `${t.id}  ${t.model} / ${t.effort}` : '?'}  (task peak: ${run.peakTier ?? run.tier})`,
    `Task: ${run.stepsInTask} steps (cap ${p.maxStepsPerTask}), ${run.toolCallsInTask} tool calls`,
    `Escalations ${bar(run.escalations, p.maxEscalationsPerTask)}, loop strikes ${bar(run.loopStrikes, 3)}, error streak ${bar(run.errorStreak, p.errorStreak)}`,
    `Clean steps ${bar(run.cleanSteps, p.cooldownSteps)}${run.tier > p.baseTier && !run.pinned ? ' (steps down at full)' : ''}`,
    `Review: ${p.review.mode}, round ${bar(run.reviewRounds, p.review.maxRounds)}`,
    `Asks this task: ${run.escalationRequests ?? 0} escalation requests, ${run.consults ?? 0} oracle consults`,
  ]
  if (run.lastLoop) lines.push(`Last loop: ${run.lastLoop}`)
  const spend = Object.entries(run.spend)
  if (spend.length) {
    lines.push('Spend (steps, output tok, cache-read tok):')
    for (const [k, s] of spend) lines.push(`  ${k}: ${s.steps}, ${s.output}, ${s.cacheRead}`)
  }
  return lines.join('\n')
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Tier ladder as a small SVG (top = oracle), the current rung highlighted. For surfaces with no fields. */
export function gaugeSvg(p: Policy, run: RunState): string {
  const rowH = 30
  const w = 320
  const h = p.tiers.length * rowH + 8
  const rows = [...p.tiers.keys()].reverse().map((i, row) => {
    const t = p.tiers[i]!
    const y = 4 + row * rowH
    const now = i === run.tier
    const text = `${i} ${t.id}  ${t.model.replace('claude-', '')} / ${t.effort}${now ? '  <' : ''}`
    return (
      `<rect x="4" y="${y}" width="${w - 8}" height="${rowH - 6}" rx="6" fill="${now ? '#2e7d32' : '#78909c'}" opacity="${now ? 1 : 0.6}"/>` +
      `<text x="14" y="${y + (rowH - 6) / 2 + 5}" font-family="sans-serif" font-size="14" fill="#ffffff">${esc(text)}</text>`
    )
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${rows.join('')}</svg>`
}

/** Settings that get a - / + stepper on the Button-only pane, with the step each press takes. */
export const STEPPERS: { key: string; step: number }[] = [
  { key: 'cooldown', step: 1 },
  { key: 'maxEscalations', step: 1 },
  { key: 'stepsPerTier', step: 5 },
  { key: 'errorStreak', step: 1 },
  { key: 'reviewRounds', step: 1 },
  { key: 'reviewMinCalls', step: 1 },
]
