import type { EngineInterface, Register } from 'claude-code'

import type { Ev, Interval, PeriodKind, Row } from './time'
import { monthKey, monthsOf, parseLog, periodOf, renderTable, tally } from './time'

// This session's identity and its own events, per month. Only this session writes its file, so
// parallel sessions (any account) never overwrite each other; /timesheet reads every file.
let session = ''
let project = ''
let turnStart: number | null = null
const own = new Map<string, Ev[]>()

/** Your own gestures: typed or queued at the prompt, or sent from the phone (Remote Control). */
const USER_ORIGINS = new Set(['composer', 'bridge'])

const PERIOD_ARG: Record<string, PeriodKind> = { '': 'today', today: 'today', week: 'week', month: 'month' }
const PERIOD_NAME: Record<PeriodKind, string> = { today: 'hôm nay', week: 'tuần này', month: 'tháng này' }

const shorten = (s: string, max: number) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

const basename = (path: string) =>
  path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || path

/** Bookkeeping beside the engine's work: a failure is logged, never passed on to the call. */
async function quietly($: EngineInterface, what: string, fn: () => Promise<unknown>) {
  try {
    await fn()
  } catch (error) {
    $.ui.log(`timesheet: ${what} failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
  }
}

/** The shared folder, in the home folder: outside every CLAUDE_CONFIG_DIR, so all accounts write here. */
async function baseDir($: EngineInterface): Promise<string | null> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return home ? `${home.replace(/\\/g, '/')}/.timesheet` : null
}

/** The project is the git root's folder name, or the working directory's when there is no repository. */
async function identify($: EngineInterface) {
  if (session) return
  const [id, repo, cwd] = await Promise.all([$.session.id(), $.session.repo().catch(() => null), $.session.cwd()])
  session = id
  project = basename(repo?.root ?? cwd)
}

async function ownFile($: EngineInterface, month: string): Promise<string | null> {
  const dir = await baseDir($)
  return dir ? `${dir}/${month}/${session}.jsonl` : null
}

/** Reads this session's file for the month back once (after a reload the module's memory is empty). */
async function loadOwn($: EngineInterface, month: string): Promise<Ev[]> {
  const have = own.get(month)
  if (have) return have
  const path = await ownFile($, month)
  const text = path ? await $.fs.read(path).catch(() => '') : ''
  const list = typeof text === 'string' ? parseLog(text) : []
  own.set(month, list)
  return list
}

async function record($: EngineInterface, make: (at: number) => Ev) {
  await identify($)
  const at = await $.clock.now()
  const ev = make(at)
  const month = monthKey(ev.t === 'turn' ? ev.end : ev.at)
  const list = await loadOwn($, month)
  list.push(ev)
  const path = await ownFile($, month)
  if (path) await $.fs.write(path, `${list.map(e => JSON.stringify(e)).join('\n')}\n`)
}

/** Every session's events for the months a period touches. */
async function readAll($: EngineInterface, period: Interval): Promise<Ev[]> {
  const dir = await baseDir($)
  if (!dir) return []
  const out: Ev[] = []
  for (const month of monthsOf(period)) {
    const entries = await $.fs.list(`${dir}/${month}`).catch(() => [])
    for (const entry of entries) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.jsonl')) continue
      const text = await $.fs.read(`${dir}/${month}/${entry.name}`).catch(() => '')
      if (typeof text === 'string') out.push(...parseLog(text))
    }
  }
  return out
}

type Cache = Record<string, { n: number; text: string }>

const SUMMARY_SYSTEM = `You label a developer's work. From the prompts they sent an AI coding assistant, write ONE short phrase (at most 40 characters) naming the main things done, comma-separated, like "API checkout, fix auth, migration". Use the language most prompts are written in. Output only the phrase: no quotes, no period, no preamble.`

/**
 * A short label of what was done, from the period's prompts, by haiku. Cached per project and
 * period, and kept while the prompt count is unchanged. Any failure leaves it empty.
 */
async function summarize($: EngineInterface, row: Row, kind: PeriodKind, period: Interval, cache: Cache): Promise<string> {
  if (row.prompts.length === 0) return ''
  const key = `${row.project}|${kind}|${period[0]}`
  const hit = cache[key]
  if (hit && hit.n === row.prompts.length) return hit.text
  const prompts = row.prompts.slice(-40).map(p => `- ${shorten(p, 120)}`)
  const result = await $.model
    .complete({ model: 'haiku', system: SUMMARY_SYSTEM, prompt: prompts.join('\n'), maxTokens: 60, timeoutMs: 20_000 })
    .catch(() => null)
  if (!result?.isAnswered) return hit?.text ?? ''
  const text = shorten(result.text.split('\n')[0]?.replace(/^["'“”\s]+|["'“”.\s]+$/g, '') ?? '', 40)
  cache[key] = { n: row.prompts.length, text }
  return text
}

async function report($: EngineInterface, kind: PeriodKind): Promise<string> {
  const now = await $.clock.now()
  const period = periodOf(kind, now)
  const { rows, mineTotal, aiTotal } = tally(await readAll($, period), period)
  if (rows.length === 0) return `Chưa có dữ liệu cho ${PERIOD_NAME[kind]}.`

  const dir = await baseDir($)
  const cachePath = dir ? `${dir}/summaries.json` : null
  let cache: Cache = {}
  try {
    const text = cachePath ? await $.fs.read(cachePath).catch(() => '') : ''
    cache = typeof text === 'string' && text ? (JSON.parse(text) as Cache) : {}
  } catch {
    cache = {}
  }
  const summaries = await Promise.all(rows.map(r => summarize($, r, kind, period, cache).catch(() => '')))
  if (cachePath) await $.fs.write(cachePath, JSON.stringify(cache)).catch(() => undefined)

  return renderTable(
    rows.map((r, i) => ({ ...r, summary: summaries[i] ?? '' })),
    mineTotal,
    aiTotal,
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'timesheet',
      description: 'Time per project: your work, AI time, turns (today, week or month)',
      argumentHint: '[week|month]',
    })
    const started = await next(e)
    await quietly($, 'load', async () => {
      await identify($)
      await loadOwn($, monthKey(await $.clock.now()))
    })

    return started
  })

  // Something you did: a prompt or a slash command, typed or from the phone.
  on('prompt.submit', async ($, e, next) => {
    if (USER_ORIGINS.has(e.origin.kind)) {
      const text = e.command ? undefined : shorten(e.text, 200)
      await quietly($, 'record prompt', () => record($, at => ({ t: 'act', at, project, session, ...(text ? { text } : {}) })))
    }

    return next(e)
  })

  // Answering a question is something you did too: its time is when the answer comes back.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined) await quietly($, 'record answer', () => record($, at => ({ t: 'act', at, project, session })))

    return ran
  })

  // AI time: a main-loop turn from start to end, the subagents it waits on included.
  on('turn.start', async ($, e, next) => {
    if (!e.agentId) turnStart = await $.clock.now()

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const start = turnStart
    if (!e.agentId && start !== null) {
      turnStart = null
      await quietly($, 'record turn', () => record($, end => ({ t: 'turn', start, end, project, session })))
    }

    return done
  })

  on('command.run', { command: 'timesheet' }, async ($, e) => {
    const kind = PERIOD_ARG[e.args.trim().toLowerCase()]
    if (!kind) return { text: 'Usage: /timesheet · /timesheet week · /timesheet month' }

    return { text: await report($, kind) }
  })
}
