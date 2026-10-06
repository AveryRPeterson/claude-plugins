import { expect, mock, test } from 'claude-code/testing'

test('/ladder log reports an empty log, then the events a manual move records', async ($, on) => {
  mock.clock(on, { now: Date.UTC(2026, 9, 2, 18, 30, 5) })
  on('ui.status', () => undefined as never)

  const empty = await $.command.run({ command: 'ladder', args: 'log', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(empty.text).toBe('No events yet.')

  await $.command.run({ command: 'ladder', args: 'up', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  const out = await $.command.run({ command: 'ladder', args: 'log', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(out.text).toContain('Recent events:')
  expect(out.text).toMatch(/2026-10-02 18:30:05 manual\s+\d→\d manual/)
  expect(out.text).toContain('Task status:')
})

test('/ladder status, help, set, tier and bridge-origin bare command all answer in text', async ($, on) => {
  mock.clock(on, { now: Date.UTC(2026, 9, 2, 18, 30, 5) })
  on('ui.status', () => undefined as never)
  on('store.set', () => ({ value: undefined }) as never)
  const run = (args: string, kind: 'composer' | 'bridge' = 'composer') =>
    $.command.run({ command: 'ladder', args, origin: { kind } as never, presentation: { isFullscreen: false, columns: 80 } })

  expect((await run('status')).text).toContain('Ladder: ')
  expect((await run('help')).text).toContain('Ladder commands')
  expect((await run('--help')).text).toContain('Ladder commands')
  expect((await run('bogus')).text).toContain('Unknown subcommand "bogus"')

  const bare = (await run('', 'bridge')).text ?? ''
  expect(bare).toContain('Ladder: ')
  expect(bare).toContain('Ladder commands')

  expect((await run('set cooldown 7')).text).toBe('Set cooldown = 7')
  expect((await run('get')).text).toContain('cooldown = 7')
  expect((await run('set cooldown nope')).text).toContain('needs a number')
  expect((await run('tier 0 sonnet low')).text).toContain('rung 0')
  const tiers = (await run('tier')).text ?? ''
  expect(tiers).toContain('0  scout  claude-sonnet-5-5  low') // the edited rung
  expect(tiers).toContain('1* worker') // the balanced preset starts on rung 1
})
