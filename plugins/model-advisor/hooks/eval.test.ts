import { expect, test } from 'claude-code/testing'

import { parseFamily, refine } from './classify'
import { PROMPTS } from './prompts'
import { assess, isAgreement, MODEL_RANK, stronger } from './score'

test('a short agreement is recognised, a substantive request is not', () => {
  for (const t of ['yes', 'Yes, go ahead', 'ok', 'do it', 'да', 'Да, делай', 'разрешаю']) expect(isAgreement(t)).toBe(true)
  for (const t of ['yes, but first explain how the cache works in this module', 'Explain the architecture', 'make a report']) expect(isAgreement(t)).toBe(false)
  expect(stronger(assess('Rename the variable'), assess('Find the root cause of the race condition')).model).toBe('opus')
})

test('on agreement the scope comes from the assistant plan, not from "yes"', async ($, on) => {
  const logs: string[] = []
  on('session.model', () => ({ value: 'claude-haiku-5-5' }))
  on('session.messages', () => ({ value: [{ role: 'assistant', text: 'Plan: design the architecture and audit the order handler for a race condition', toolUses: [] }] }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined } })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  await $.prompt.submit({ text: 'yes', wait: false, origin: { kind: 'composer' } })
  expect(logs[0]).toContain('opus')
})

test('the classifier is called only for ambiguous prompts', async () => {
  let calls = 0
  const ask = async () => { calls++; return 'opus' as const }
  const text = 'Make everything faster and more reliable'
  const hard = await refine(assess(text), text, ask)
  expect(hard.model).toBe('opus')
  const keyworded = 'Fix the bug in the order handler'
  await refine(assess(keyworded), keyworded, ask)
  expect(calls).toBe(1)
  expect(parseFamily('Sonnet.')).toBe('sonnet')
  expect(parseFamily("I don't know")).toBeUndefined()
})

test('model-choice accuracy on the labelled set', () => {
  let ok = 0
  const under: string[] = []
  const over: string[] = []
  for (const p of PROMPTS) {
    const got = assess(p.text).model
    const d = MODEL_RANK[got] - MODEL_RANK[p.expected]
    if (d === 0) ok++
    else (d < 0 ? under : over).push(`${p.expected}→${got}: ${p.text.slice(0, 60)}`)
  }
  console.log(`accuracy ${ok}/${PROMPTS.length}, under-estimated ${under.length}, over-estimated ${over.length}`)
  under.forEach(s => console.log('  UNDER ' + s))
  over.forEach(s => console.log('  over ' + s))
  expect(under.length).toBeLessThanOrEqual(PROMPTS.length * 0.1)
})
