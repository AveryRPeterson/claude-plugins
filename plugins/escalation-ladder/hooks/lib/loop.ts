import type { Policy } from '../../types'

export type Seen = { sig: string; resultHash: string; isError: boolean; errKey: string }

export type LoopHit = {
  kind: 'repeat' | 'pingpong' | 'same-error'
  detail: string
}

/** Stable JSON: object keys sorted so argument order never changes a signature. */
export function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined'
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .sort()
    .map(k => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(',')}}`
}

/** Cheap non-crypto hash (djb2) so rings hold short strings, not tool output. */
export function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/** What counts as "the same call": tool plus arguments, whitespace-normalised. */
export function signature(tool: string, input: Record<string, unknown>): string {
  // description/timeout are prose or tuning, not identity: a model rewords them when it repeats a call.
  const { tool_use_id: _a, agentId: _b, consent: _c, description: _d, timeout: _e, ...args } = input
  const norm: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    norm[k] = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : v
  }
  return `${tool}:${hash(stable(norm))}`
}

/**
 * An error's identity: digits, paths and hex stripped so "line 41" and "line 52"
 * match. Keys on the tail, where the failure is, not on a leading banner.
 */
export function errorKey(text: string): string {
  return hash(
    text
      .slice(-400)
      .toLowerCase()
      .replace(/0x[0-9a-f]+/g, '#')
      .replace(/[a-z]:\\[^\s'"]*|(?:\/[\w.-]+){2,}/g, '<path>')
      .replace(/\b[0-9a-f]{7,}\b/g, '#')
      .replace(/\d+/g, '#')
      .replace(/\s+/g, ' '),
  )
}

/**
 * Per-loop ring of recent calls. Pure: feed it `push` after each call, ask
 * `check` for a hit. Detection is on (signature, result) pairs, not signatures
 * alone, because re-running the same test command after an edit is legitimate
 * and only a repeat that returns the same thing is "no new information".
 */
export class LoopDetector {
  private ring: Seen[] = []
  constructor(private readonly cap = 26) {}

  push(s: Seen): void {
    this.ring.push(s)
    if (this.ring.length > this.cap) this.ring.shift()
  }

  clear(): void {
    this.ring = []
  }

  check(cfg: Policy['loop']): LoopHit | null {
    const r = this.ring
    const n = r.length
    if (n < 2) return null

    // 1. identical call, identical result, N times in a row
    const last = r[n - 1]!
    let run = 1
    for (let i = n - 2; i >= 0; i--) {
      const x = r[i]!
      if (x.sig === last.sig && x.resultHash === last.resultHash) run++
      else break
    }
    if (run >= cfg.repeat) {
      return { kind: 'repeat', detail: `same call and same result ${run}x in a row` }
    }

    // 2. same error from the same tool, N times in a row (arguments may differ)
    if (last.isError) {
      let errs = 1
      for (let i = n - 2; i >= 0; i--) {
        const x = r[i]!
        if (x.isError && x.errKey === last.errKey) errs++
        else break
      }
      if (errs >= cfg.sameError) {
        return { kind: 'same-error', detail: `same error ${errs}x in a row` }
      }
    }

    // 3. A,B,A,B... alternation: last 2*pingPong calls use exactly two signatures
    const span = cfg.pingPong * 2
    if (n >= span) {
      const w = r.slice(n - span)
      const a = w[0]!.sig
      const b = w[1]!.sig
      // Results must repeat too: polling a starting server alternates two calls with changing output.
      if (a !== b && w.every((x, i) => x.sig === (i % 2 === 0 ? a : b) && x.resultHash === w[i % 2]!.resultHash)) {
        return { kind: 'pingpong', detail: `alternating between two calls ${cfg.pingPong}x` }
      }
    }
    return null
  }
}
