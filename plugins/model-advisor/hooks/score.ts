// Pure scoring logic with no engine access, so it is easy to test.
// Complexity (how much thinking the task needs) and volume (how much text/code it carries)
// are scored separately: a large but routine task does NOT raise the model.
// Keyword lists cover English and Russian prompts.

export type Family = 'haiku' | 'sonnet' | 'opus'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Tier = 'simple' | 'standard' | 'complex' | 'expert'
export type Volume = 'small' | 'medium' | 'large'

export const MODEL_RANK: Record<Family, number> = { haiku: 0, sonnet: 1, opus: 2 }
export const EFFORT_ORDER: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export const TIERS: Record<Tier, { model: Family; effort: Effort; label: string }> = {
  simple: { model: 'haiku', effort: 'low', label: 'simple' },
  standard: { model: 'sonnet', effort: 'medium', label: 'ordinary' },
  complex: { model: 'opus', effort: 'high', label: 'complex' },
  expert: { model: 'opus', effort: 'xhigh', label: 'very complex' },
}

const VOLUME_LABEL: Record<Volume, string> = { small: 'small', medium: 'medium', large: 'large' }

// Patterns are matched against the lower-cased prompt.
const HARD = [
  /архитектур/, /спроектир/, /проектирован/, /аудит/, /root cause/, /первопричин/,
  /race condition/, /гонк[аи] данных/, /deadlock/, /дедлок/, /утечк[аи] памяти/,
  /уязвимост/, /security/, /trade-?off/, /компромисс/, /докаж/, /формальн/,
  /architecture/, /почему (не )?работает/, /найди все баги/, /стратеги[юя].{0,30}(разработ|придума)/,
  /многопоточн/, /concurren/, /оптимальн.{0,20}алгоритм/,
  /memory leak/, /threat model/, /design (a|the) system/, /why (is|does|isn'?t|doesn'?t) .{0,30}(work|fail)/,
  /find all (the )?bugs/, /formal proof/, /optimal algorithm/,
]
const MEDIUM = [
  /реализуй/, /напиши/, /исправь/, /\bбаг/, /ошибк/, /implement/, /\bfix/, /debug/,
  /отлад/, /тест/, /рефактор/, /оптимизир/, /добавь функци/, /перепиши/, /портир/,
  /индикатор/, /советник/, /\bea\b/, /mql[45]?/, /pine/,
  /\bwrite\b/, /refactor/, /optimi[sz]e/, /\bbug\b/, /\btests?\b/, /add (a )?(function|feature|endpoint)/, /rewrite/, /\bport\b/,
]
const TRIVIAL = [
  /переименуй/, /rename/, /опечатк/, /typo/, /commit message/, /что делает/,
  /объясни кратко/, /переведи/, /translate/, /отформатируй/, /format this/,
  /добавь комментари/, /замени .{1,40} на /, /сконвертируй/, /convert/,
  /what does .{1,40} do/, /explain briefly/, /add comments?/, /replace .{1,40} with /,
]

// Weak signals of a hard task without the loud words: irregularity, a justified choice,
// finding a cause, guarantees, constraints. One signal is not enough (an everyday request
// can say "sometimes"), so the task counts as complex only when two groups match.
const SUBTLE = [
  /иногда|sometimes|intermittent|раз в (несколько|\d)|воспроизводим|reproduc/,
  /выбрать между|выбери|choose|pick one|сравни варианты|compare (the )?(options|approaches)/,
  /обоснуй|justify|prove|guarantee|гаранти|никогда не|never/,
  /mechanism|механизм|what could explain|why (does|is)|что лежит в основе|откуда/,
  /propose|предложи|придумай|work out why|выясни|разберись|нужно понять/,
  /under load|при нагрузке|хотя|even though|although|учти|учитывая|taking into account|given that|без |without /,
]

export type Assessment = {
  tier: Tier
  volume: Volume
  score: number
  reasons: string[]
  model: Family
  effort: Effort
  uncertain: boolean
}

export function effortFor(tier: Tier, volume: Volume): Effort {
  // A large routine task keeps the cheap model but gets medium effort,
  // so long text or code is not processed "at minimum".
  return tier === 'simple' && volume === 'large' ? 'medium' : TIERS[tier].effort
}

function hits(patterns: RegExp[], text: string): string[] {
  return patterns.filter(p => p.test(text)).map(p => p.source.replace(/\\b|\.\{.*?\}|[()?[\]]/g, ''))
}

export function assess(text: string): Assessment {
  const low = text.toLowerCase()
  const reasons: string[] = []
  let score = 0

  const h = hits(HARD, low)
  const m = hits(MEDIUM, low)
  const t = hits(TRIVIAL, low)
  if (h.length) { score += 3 * Math.min(h.length, 2); reasons.push(`hard: ${h.slice(0, 3).join(', ')}`) }
  if (m.length) { score += Math.min(m.length, 2); reasons.push(`work: ${m.slice(0, 3).join(', ')}`) }
  if (t.length) { score -= 2 * Math.min(t.length, 2); reasons.push(`routine: ${t.slice(0, 3).join(', ')}`) }
  const s = SUBTLE.filter(p => p.test(low)).length
  if (s >= 2) { score += 3; reasons.push(`non-trivial signals (${s})`) }
  if (!h.length && !m.length && !s && text.length < 60) score -= 1

  const codeLines = (text.match(/```[\s\S]*?```/g) ?? []).reduce((n, b) => n + b.split('\n').length, 0)
  const size = text.length
  const volume: Volume = size >= 2500 || codeLines >= 80 ? 'large' : size >= 800 || codeLines >= 25 ? 'medium' : 'small'

  const tier: Tier = score >= 7 ? 'expert' : score >= 3 ? 'complex' : score >= 0 ? 'standard' : 'simple'

  return { tier, volume, score, reasons, model: TIERS[tier].model, effort: effortFor(tier, volume), uncertain: reasons.length === 0 }
}

// A short "yes, go ahead" carries no task: take it from the assistant's proposal and earlier work.
const AGREE = /^(да|ага|ок|окей|ладно|давай|делай|погнали|поехали|согласен|согласна|разрешаю|продолжай|yes|yep|ok|okay|sure|go|go ahead|proceed|continue|do it|sounds good|lgtm)(?![а-яёa-z])/i

export function isAgreement(text: string): boolean {
  const t = text.trim()
  return t.length <= 40 && AGREE.test(t)
}

export function stronger(a: Assessment, b: Assessment): Assessment {
  const d = MODEL_RANK[a.model] - MODEL_RANK[b.model] || EFFORT_ORDER.indexOf(a.effort) - EFFORT_ORDER.indexOf(b.effort)
  return d >= 0 ? a : b
}

export function family(modelId: string | undefined): Family | undefined {
  const id = (modelId ?? '').toLowerCase()
  return (Object.keys(MODEL_RANK) as Family[]).find(f => id.includes(f))
}

export function normalizeEffort(e: unknown): Effort | undefined {
  return typeof e === 'string' && (EFFORT_ORDER as readonly string[]).includes(e) ? (e as Effort) : undefined
}

export type Advice = { line: string; toast?: string; status: string }

export function advise(a: Assessment, currentModel: string | undefined, currentEffort: Effort | undefined): Advice {
  const cur = family(currentModel)
  const curText = `${currentModel ?? 'model unknown'} · effort ${currentEffort ?? '?'}`
  const head =
    `[Model Advisor] Task: ${TIERS[a.tier].label}, volume: ${VOLUME_LABEL[a.volume]}` +
    (a.reasons.length ? ` (${a.reasons.join('; ')})` : '') +
    `. Recommended: ${a.model} · effort ${a.effort}. Now: ${curText}.`

  const parts: string[] = [head]
  let toast: string | undefined

  if (cur !== undefined) {
    const diff = MODEL_RANK[a.model] - MODEL_RANK[cur]
    if (diff < 0) {
      const why = a.volume !== 'small' ? 'The task is large but not hard; ' : ''
      parts.push(`${why}a lower-tier model can handle it: /model ${a.model}.`)
      toast = `${why}${a.model} can handle it (effort ${a.effort})`
    } else if (diff > 0) {
      parts.push(`A stronger model is needed: /model ${a.model}.`)
      toast = `${a.model} fits better (effort ${a.effort})`
    } else {
      parts.push('The model fits.')
    }
  }

  if (currentEffort && currentEffort !== a.effort) {
    parts.push(`Effort: change ${currentEffort} → ${a.effort}.`)
  } else if (!currentEffort) {
    parts.push(`Effort: set ${a.effort}.`)
  } else {
    parts.push('Effort fits.')
  }

  return { line: parts.join(' '), toast, status: `advisor → ${a.model} · ${a.effort}` }
}
