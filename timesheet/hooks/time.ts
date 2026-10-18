// The time math, as pure functions: periods in local time, work blocks, interval union, the table.
// Every number comes from recorded timestamps; nothing here estimates.

/** One recorded event. `act` is something you did; `turn` is one main-loop turn, start to end. */
export type Ev =
  | { t: 'act'; at: number; project: string; session: string; text?: string }
  | { t: 'turn'; start: number; end: number; project: string; session: string }

export type Interval = [number, number]
export type PeriodKind = 'today' | 'week' | 'month'

/** A gap longer than this between two of your activities ends a work block. */
export const GAP_MS = 10 * 60_000
/** [from, to) in local time: today; this week Monday to Sunday; this month. */
export const periodOf = (kind: PeriodKind, now: number): Interval => {
  const d = new Date(now)
  if (kind === 'today') {
    return [
      new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(),
      new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime(),
    ]
  }
  if (kind === 'week') {
    const back = (d.getDay() + 6) % 7 // Monday is 0
    return [
      new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime(),
      new Date(d.getFullYear(), d.getMonth(), d.getDate() - back + 7).getTime(),
    ]
  }
  return [new Date(d.getFullYear(), d.getMonth(), 1).getTime(), new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()]
}

/** The months a period touches, as `YYYY-MM`: the log's folder names. */
export const monthsOf = ([from, to]: Interval): string[] => {
  const out: string[] = []
  const d = new Date(from)
  let y = d.getFullYear()
  let m = d.getMonth()
  while (new Date(y, m, 1).getTime() < to) {
    out.push(monthKey(new Date(y, m, 1).getTime()))
    m += 1
    if (m === 12) {
      m = 0
      y += 1
    }
  }
  return out
}

export const monthKey = (at: number) => {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** Your activities, merged: consecutive ones no more than GAP_MS apart form one block, first to last. */
export const blocksOf = (times: readonly number[], gap = GAP_MS): Interval[] => {
  const sorted = [...times].sort((a, b) => a - b)
  const out: Interval[] = []
  for (const at of sorted) {
    const last = out[out.length - 1]
    if (last && at - last[1] <= gap) last[1] = at
    else out.push([at, at])
  }
  return out
}

/** Cuts intervals at local midnights, so a block across midnight counts toward each day it covers. */
export const splitByDay = (list: readonly Interval[]): Interval[] =>
  list.flatMap(([a, b]) => {
    const parts: Interval[] = []
    let start = a
    while (start < b) {
      const end = Math.min(b, nextMidnight(start))
      parts.push([start, end])
      start = end
    }
    return parts.length ? parts : [[a, b] as Interval]
  })

const nextMidnight = (at: number) => {
  const d = new Date(at)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
}

/** The union of intervals: overlapping or touching ones count once. */
export const union = (list: readonly Interval[]): Interval[] => {
  const sorted = list.filter(([a, b]) => b >= a).sort((x, y) => x[0] - y[0])
  const out: Interval[] = []
  for (const [a, b] of sorted) {
    const last = out[out.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

export const clip = (list: readonly Interval[], [from, to]: Interval): Interval[] =>
  list.map(([a, b]): Interval => [Math.max(a, from), Math.min(b, to)]).filter(([a, b]) => b > a)

export const total = (list: readonly Interval[]) => list.reduce((s, [a, b]) => s + (b - a), 0)

export type Row = { project: string; mine: number; ai: number; turns: number; prompts: string[] }

/**
 * Per project in the period: your time (each session's activities cut into blocks at 10-minute
 * gaps, then the blocks of all sessions united, per day; the end of each AI turn is an activity
 * too, since that is when you start reading the answer), AI time (turns summed, so parallel
 * sessions add up), turns started, and the prompts for the summary. Also the total of your time
 * across all projects, united once more so two projects at the same moment count once.
 */
export const tally = (events: readonly Ev[], period: Interval): { rows: Row[]; mineTotal: number; aiTotal: number } => {
  const byProject = new Map<string, Ev[]>()
  for (const e of events) byProject.set(e.project, [...(byProject.get(e.project) ?? []), e])

  const allBlocks: Interval[] = []
  const rows: Row[] = []
  for (const [project, list] of byProject) {
    const bySession = new Map<string, number[]>()
    for (const e of list) {
      const at = e.t === 'act' ? e.at : e.end
      bySession.set(e.session, [...(bySession.get(e.session) ?? []), at])
    }
    const blocks = [...bySession.values()].flatMap(times => blocksOf(times))
    const mineIntervals = clip(union(splitByDay(blocks)), period)
    allBlocks.push(...mineIntervals)
    const turns = list.filter((e): e is Extract<Ev, { t: 'turn' }> => e.t === 'turn')
    const ai = turns.reduce((s, e) => s + total(clip([[e.start, e.end]], period)), 0)
    const started = turns.filter(e => e.start >= period[0] && e.start < period[1]).length
    const prompts = list
      .filter((e): e is Extract<Ev, { t: 'act' }> => e.t === 'act' && typeof e.text === 'string' && e.at >= period[0] && e.at < period[1])
      .map(e => e.text ?? '')
    const mine = total(mineIntervals)
    if (mine > 0 || ai > 0 || started > 0) rows.push({ project, mine, ai, turns: started, prompts })
  }
  rows.sort((a, b) => b.mine - a.mine || b.ai - a.ai || a.project.localeCompare(b.project))
  return { rows, mineTotal: total(union(allBlocks)), aiTotal: rows.reduce((s, r) => s + r.ai, 0) }
}

/** `6h40`, or `25m` under an hour. */
export const fmtDuration = (ms: number) => {
  const m = Math.round(ms / 60_000)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}

/** The table, monospace, number columns right-aligned. */
export const renderTable = (rows: readonly (Row & { summary: string })[], mineTotal: number, aiTotal: number): string => {
  const name = (s: string) => (s.length > 16 ? `${s.slice(0, 15)}…` : s).padEnd(16)
  const line = (p: string, mine: string, ai: string, turns: string, what: string) =>
    `${name(p)} ${mine.padStart(7)}   ${ai.padStart(7)}   ${turns.padStart(4)}    ${what}`.trimEnd()
  const head = line('Project', 'Bạn làm', 'AI chạy', 'Lượt', 'Việc chính')
  const body = rows.map(r => line(r.project, fmtDuration(r.mine), fmtDuration(r.ai), String(r.turns), r.summary))
  const rule = '─'.repeat(Math.max(54, ...[head, ...body].map(l => Math.min(l.length, 80))))
  return [head, ...body, rule, line('Tổng', fmtDuration(mineTotal), fmtDuration(aiTotal), '', '')].join('\n')
}

/** Reads one session's log file leniently: a line that does not parse is skipped. */
export const parseLog = (text: string): Ev[] =>
  text.split('\n').flatMap((line): Ev[] => {
    if (!line.trim()) return []
    try {
      const e = JSON.parse(line) as Ev
      if (e.t === 'act' && typeof e.at === 'number' && typeof e.project === 'string') return [e]
      if (e.t === 'turn' && typeof e.start === 'number' && typeof e.end === 'number' && typeof e.project === 'string') return [e]
      return []
    } catch {
      return []
    }
  })
