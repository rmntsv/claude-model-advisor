import { expect, test } from 'claude-code/testing'

import { advise, assess } from './score'

const BIG_ROUTINE = 'Rename the variable lot to lotSize in the whole file:\n```\n' + 'double lot = 0.01;\n'.repeat(120) + '```'

test('hard task → opus + high', () => {
  const a = assess('Design the architecture of a trading system and audit the order handler for a race condition')
  expect(a.model).toBe('opus')
  expect(['high', 'xhigh']).toContain(a.effort)
})

test('a large but routine task does not raise the model', () => {
  const a = assess(BIG_ROUTINE)
  expect(a.volume).toBe('large')
  expect(a.model).toBe('haiku')
  expect(a.effort).toBe('medium')
})

test('on opus a large routine task → lower-tier notice and effort change', () => {
  const r = advise(assess(BIG_ROUTINE), 'claude-opus-5-5', 'high')
  expect(r.line).toContain('a lower-tier model can handle it')
  expect(r.line).toContain('large but not hard')
  expect(r.line).toContain('high → medium')
  expect(r.toast).toBeDefined()
})

test('effort is always advised, even when the model fits', () => {
  const r = advise(assess('Write a function that computes the average and add a test'), 'claude-sonnet-5-5', undefined)
  expect(r.line).toContain('The model fits')
  expect(r.line).toContain('Effort')
})

test('the hook logs the advice, holds the prompt on a mismatch, and lets a resend through', async ($, on) => {
  const logs: string[] = []
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('store.get', () => ({ value: undefined }))
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined } })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => ({ text: e.text }))

  const r = await $.prompt.submit({ text: BIG_ROUTINE, wait: false, origin: { kind: 'composer' } })
  expect(logs.length).toBe(1)
  expect(logs[0]).toContain('[Model Advisor]')
  expect(r.drop).toBeDefined()

  const again = await $.prompt.submit({ text: BIG_ROUTINE, wait: false, origin: { kind: 'composer' } })
  expect(again.drop).toBeUndefined()
})
