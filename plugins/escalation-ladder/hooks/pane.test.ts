import { expect, mock, test } from 'claude-code/testing'

const PANE_PROPS = {
  title: 'Ladder',
  isFocused: true,
  bodyColumns: 40,
  placement: 'inline' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

test('the Button-only pane draws on mobile (surface-validated) and taps change state', async ($, on) => {
  mock.clock(on, { now: Date.UTC(2026, 9, 2, 18, 30, 5) })
  on('ui.status', () => undefined as never)
  on('ui.toast', () => undefined as never)
  on('store.set', () => ({ value: undefined }) as never)

  // Mounting validates the returned tree against the mobile element table: it fails if the
  // pane uses anything the phone cannot draw (Input, Select, ...).
  const ui = await $.ui.mount({ plugin: 'escalation-ladder', surface: 'mobile', component: 'Pane', requestId: 'ladder', props: PANE_PROPS })

  expect(await ui.find({ type: 'Svg' })).toBeDefined()
  expect((await ui.find({ key: 'm-pin' }))?.text).toBe('Pin')

  await ui.press({ key: 'm-pin' })
  expect((await ui.find({ key: 'm-pin' }))?.text).toBe('Unpin')
  await ui.press({ key: 'm-pin' })
  expect((await ui.find({ key: 'm-pin' }))?.text).toBe('Pin')

  const before = (await ui.find({ type: 'Text', text: /cooldown = / }))?.text ?? ''
  await ui.press({ key: 's-cooldown-plus' })
  const after = (await ui.find({ type: 'Text', text: /cooldown = / }))?.text ?? ''
  expect(after).not.toBe(before)
  await ui.press({ key: 's-cooldown-minus' })
  expect((await ui.find({ type: 'Text', text: /cooldown = / }))?.text).toBe(before)

  await ui.press({ key: 'm-p-frugal' })
  expect((await ui.find({ type: 'Text', text: /Ladder .*scout/ }))?.text).toContain('scout')

  await ui.unmount()
})
