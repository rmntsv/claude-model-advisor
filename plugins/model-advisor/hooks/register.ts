import type { Register } from 'claude-code'

import { CLASSIFIER_MODEL, CLASSIFIER_SYSTEM, parseFamily, refine } from './classify'
import { advise, assess, family, isAgreement, MODEL_RANK, normalizeEffort, stronger, TIERS, type Assessment, type Effort, type Family } from './score'

type HistoryEntry = { len: number; rec: Family; cur: Family | undefined; uncertain: boolean; cls: boolean; switched: boolean }
const HISTORY_LIMIT = 500

// Scoring runs locally and costs no tokens. The only model call is the optional Haiku
// classifier for prompts with no keyword hits; transcript lines ($.ui.log) never reach the model.

const MIN_CHARS = 15
const CACHE_TTL_MS = 5 * 60 * 1000
const BIG_CONTEXT = 30_000

// Model ids of one generation differ only in the family word (claude-<family>-<version>).
const swapFamily = (id: string, f: Family) => id.replace(/haiku|sonnet|opus/i, f)

export const register: Register = on => {
  let lastEffort: Effort | undefined
  let lastModelFamily: Family | undefined
  let lastWork: Assessment | undefined
  // Classifier results by prompt text, for the session: repeats cost no tokens.
  const classified = new Map<string, Family | undefined>()
  // A prompt held back with no answer to the question: sending the same text again lets it through.
  let held: string | undefined
  // The model the user agreed to switch to; substituted into main-thread requests until the
  // recommendation changes. A round trip costs more: the prompt cache is rewritten each way.
  let override: Family | undefined
  let lastSessionFamily: Family | undefined
  // Context size and time of the last request, for the switch-cost hint.
  let contextTokens = 0
  let lastStepAt = 0

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'model-advisor',
      description: 'Model Advisor: /model-advisor on | off | classifier on|off | ask on|off | reset | stats',
    })
    return next(e)
  })

  on('command.run', { command: 'model-advisor' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off' || arg === 'on') {
      await $.store.set('disabled', arg === 'off')
      if (arg === 'off') $.ui.status(undefined)
      return { text: `Model Advisor ${arg === 'off' ? 'disabled' : 'enabled'}.` }
    }
    if (arg === 'classifier on' || arg === 'classifier off') {
      await $.store.set('classifier', arg.endsWith('on'))
      return { text: `Haiku classifier for ambiguous prompts ${arg.endsWith('on') ? 'enabled (spends a few tokens per prompt)' : 'disabled'}.` }
    }
    if (arg === 'ask on' || arg === 'ask off') {
      await $.store.set('ask', arg.endsWith('on'))
      return { text: `Switch question before a task ${arg.endsWith('on') ? 'enabled' : 'disabled'}.` }
    }
    if (arg === 'reset') {
      override = undefined
      $.ui.status(undefined)
      return { text: 'Model override cleared: requests use the session model again.' }
    }
    if (arg === 'stats') {
      const h = ((await $.store.get('history').catch(() => null)) as HistoryEntry[] | null) ?? []
      const n = (f: (x: HistoryEntry) => boolean) => h.filter(f).length
      return {
        text:
          `Prompts logged: ${h.length}. Recommendations: haiku ${n(x => x.rec === 'haiku')}, sonnet ${n(x => x.rec === 'sonnet')}, opus ${n(x => x.rec === 'opus')}. ` +
          `Model differed from the advice: ${n(x => x.cur !== undefined && x.cur !== x.rec)}, of which you switched: ${n(x => x.cur !== x.rec && x.switched)}. ` +
          `Ambiguous: ${n(x => x.uncertain)}, classifier answered: ${n(x => x.cls)}.`,
      }
    }
    const disabled = (await $.store.get('disabled').catch(() => null)) === true
    const cls = (await $.store.get('classifier').catch(() => null)) !== false
    return {
      text: `Model Advisor ${disabled ? 'disabled' : 'enabled'}, classifier ${cls ? 'on' : 'off'}. Model: ${await $.session.model()}, effort: ${lastEffort ?? 'not known yet'}. Commands: /model-advisor on | off | classifier on | classifier off | ask on | ask off | reset | stats.${override ? ` Requests currently go to ${override}.` : ''}`,
    }
  })

  // Remember the effort the engine really sends, apply a chosen model, track context size.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    lastEffort = normalizeEffort(e.effort) ?? lastEffort
    const r = yield* next(override ? { ...e, model: swapFamily(e.model, override) } : e)
    if (r.usage) {
      contextTokens = r.usage.input_tokens + r.usage.cache_read_input_tokens + r.usage.cache_creation_input_tokens
      lastStepAt = Date.now()
    }
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)
    const agree = isAgreement(e.text)
    if (!agree && e.text.trim().length < MIN_CHARS) return next(e)
    if ((await $.store.get('disabled').catch(() => null)) === true) return next(e)
    if (held === e.text) {
      held = undefined
      return next(e)
    }

    let hold: string | undefined
    try {
      let a = assess(e.text)
      if (agree) {
        // "Yes, go ahead": score the assistant's proposal and earlier work, no model call.
        const msgs = await $.session.messages({}).catch(() => [])
        const proposal = [...msgs].reverse().find(m => m.role === 'assistant' && m.text)
        const inherited = [proposal && assess(proposal.text), lastWork].filter((x): x is Assessment => !!x)
        if (inherited.length) {
          a = { ...inherited.reduce(stronger), uncertain: false, reasons: ['agreement: scope taken from the assistant\'s plan'] }
        }
      } else {
        lastWork = a
      }
      if (!agree && a.uncertain && (await $.store.get('classifier').catch(() => null)) !== false) {
        a = await refine(a, e.text, async text => {
          if (classified.has(text)) return classified.get(text)
          const r = await $.model.complete({
            model: CLASSIFIER_MODEL,
            system: CLASSIFIER_SYSTEM,
            prompt: text,
            maxTokens: 8,
            effort: 'low',
          })
          if (!r.isAnswered) return undefined
          $.ui.log(`[Model Advisor] classifier: ${r.usage.input_tokens + r.usage.cache_read_input_tokens} in + ${r.usage.output_tokens} out tokens`)
          const fam = parseFamily(r.text)
          classified.set(text, fam)
          return fam
        })
      }
      const sessionModel = await $.session.model().catch(() => undefined)
      const sessionFamily = family(sessionModel)
      if (lastSessionFamily !== undefined && sessionFamily !== lastSessionFamily) override = undefined
      lastSessionFamily = sessionFamily
      const model = override && sessionModel ? swapFamily(sessionModel, override) : sessionModel
      const advice = advise(a, model, lastEffort)
      const cur = family(model)
      // Metadata only: prompt text is never written to the log.
      const history = ((await $.store.get('history').catch(() => null)) as HistoryEntry[] | null) ?? []
      history.push({
        len: e.text.length,
        rec: a.model,
        cur,
        uncertain: a.uncertain,
        cls: a.reasons.some(r => r.startsWith('classifier')),
        switched: lastModelFamily !== undefined && cur !== lastModelFamily,
      })
      lastModelFamily = cur
      $.ui.log(advice.line)
      $.ui.status(advice.status)
      if (advice.toast) $.ui.toast(advice.toast)
      if (cur && cur !== a.model && (await $.store.get('ask').catch(() => null)) !== false) {
        const cheaper = MODEL_RANK[a.model] < MODEL_RANK[cur]
        const yes = `Switch to ${a.model}`
        const no = `Stay on ${cur}`
        const warm = lastStepAt > 0 && Date.now() - lastStepAt < CACHE_TTL_MS
        const costly = warm && contextTokens >= BIG_CONTEXT
        const hint =
          lastStepAt === 0
            ? 'the context is still empty, switching costs almost nothing'
            : `context ≈${Math.round(contextTokens / 1000)}k tokens, cache ${warm ? 'warm' : 'cold'}: ${costly ? 'switching rebuilds the cache, which costs more than staying' : 'switching costs almost nothing'}`
        const answer = await $.ui
          .ask(`${TIERS[a.tier].label} task: ${cheaper ? `${a.model} can handle it, cheaper than ${cur}` : `${a.model} fits better than ${cur}`}. The request goes to ${a.model} and stays there until the recommendation changes (${hint}). Switch?`, {
            options: costly ? [no, yes] : [yes, no],
            header: 'Model',
          })
          .catch(() => undefined)
        if (answer === yes) {
          override = a.model === sessionFamily ? undefined : a.model
          $.ui.status(override ? `requests go to ${override} (override)` : undefined)
        } else if (answer === undefined) {
          // The dialog did not show or was closed: do not start work without an answer.
          held = e.text
          hold = `Work not started: ${cheaper ? `${a.model} can handle it` : `${a.model} fits better`}, now on ${cur}. Send the same prompt again to continue on ${cur}, or run /model ${a.model} and send it again (the cache for another model is rebuilt).`
        }
      }
      await $.store.set('history', history.slice(-HISTORY_LIMIT))
    } catch {
      // the advisor must never block a prompt from being sent
    }
    if (hold) return { drop: hold }
    return next(e)
  })
}
