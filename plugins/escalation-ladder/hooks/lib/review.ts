export type Verdict = { verdict: 'pass' | 'fail' | 'unsure'; issues: string[] }

export const REVIEW_SYSTEM = [
  'You are an independent reviewer of work done by another AI coding agent.',
  'You did not do the work and have no stake in it. Be skeptical but fair.',
  'Judge ONLY from the evidence given: the task, the tool calls with their outcomes, and the final answer.',
  'Fail the work if: the task was not actually completed; the answer claims something no tool call supports;',
  'a test/build/check was never run or was run and failed; errors were ignored; or the answer silently narrowed the task.',
  'Reply with ONE JSON object and nothing else:',
  '{"verdict":"pass"|"fail"|"unsure","issues":["short, concrete, actionable"]}',
].join(' ')

type Row = {
  role: 'user' | 'assistant'
  text: string
  toolUses: { tool: string; input: Record<string, unknown>; text?: string; isError?: boolean }[]
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…[+${s.length - n}]` : s)

/** A bounded evidence packet: the task, the tool trail, the final answer. */
export function buildEvidence(rows: readonly Row[], scope: 'task' | 'milestone', note?: string): string {
  // The task is the last user row that is not a tool_result carrier and not this
  // plugin's own follow-up (a rejected answer's retry is still the original task).
  const isTask = (r: Row) => r.role === 'user' && r.text.trim() !== '' && !r.text.startsWith('[escalation-ladder]')
  let start = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    if (isTask(rows[i]!)) {
      start = i
      break
    }
  }
  const slice = rows.slice(Math.max(start, 0))
  const task = start >= 0 ? slice[0]!.text : '(original request is outside the evidence window)'
  const trail: string[] = []
  let answer = ''
  for (const r of slice) {
    if (r.role !== 'assistant') continue
    if (r.text.trim()) answer = r.text
    for (const t of r.toolUses) {
      const arg = clip(JSON.stringify(t.input ?? {}), 160)
      const out = t.text ? clip(t.text.replace(/\s+/g, ' '), 200) : '(no result)'
      trail.push(`- ${t.tool} ${arg} -> ${t.isError ? 'ERROR ' : ''}${out}`)
    }
  }
  return [
    `SCOPE: ${scope}${note ? ` (${clip(note, 300)})` : ''}`,
    `TASK:\n${clip(task, 1500)}`,
    `TOOL TRAIL (${trail.length} calls${trail.length > 40 ? ', last 40 shown' : ''}):\n${trail.slice(-40).join('\n')}`,
    `FINAL ANSWER:\n${clip(answer, 2500) || '(none)'}`,
  ].join('\n\n')
}

/** Every balanced top-level {...} span in the text, in order (string-aware). */
function jsonCandidates(text: string): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue
    let depth = 0
    let inStr = false
    for (let j = i; j < text.length; j++) {
      const c = text[j]
      if (inStr) {
        if (c === '\\') j++
        else if (c === '"') inStr = false
      } else if (c === '"') inStr = true
      else if (c === '{') depth++
      else if (c === '}' && --depth === 0) {
        out.push(text.slice(i, j + 1))
        i = j
        break
      }
    }
  }
  return out
}

const issueText = (x: unknown): string =>
  typeof x === 'string' ? x : x && typeof x === 'object' ? JSON.stringify(x) : String(x)

export function parseVerdict(text: string): Verdict {
  // Prose may contain braces, so try each balanced object and take the last one that has a verdict.
  for (const cand of jsonCandidates(text).reverse()) {
    try {
      const j = JSON.parse(cand) as { verdict?: unknown; issues?: unknown }
      const word = typeof j.verdict === 'string' ? j.verdict.trim().toLowerCase() : ''
      if (word !== 'pass' && word !== 'fail' && word !== 'unsure') continue
      const issues = Array.isArray(j.issues)
        ? j.issues.map(issueText)
        : typeof j.issues === 'string' && j.issues
          ? [j.issues]
          : []
      return { verdict: word, issues: issues.slice(0, 8) }
    } catch {
      /* try the next candidate */
    }
  }
  return { verdict: 'unsure', issues: ['reviewer reply was not valid JSON'] }
}
