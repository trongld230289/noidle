import { expect, test } from 'claude-code/testing'

import type { Ev } from '../hooks/time'
import { blocksOf, fmtDuration, monthsOf, parseLog, periodOf, renderTable, splitByDay, tally, union } from '../hooks/time'

// Local time (the test runs in the machine's zone); 18 Oct 2026 is a Sunday.
const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m).getTime()
const MIN = 60_000
const act = (session: string, project: string, time: number, text?: string): Ev => ({
  t: 'act',
  at: time,
  project,
  session,
  ...(text ? { text } : {}),
})
const turn = (session: string, project: string, start: number, end: number): Ev => ({ t: 'turn', start, end, project, session })

test('a gap longer than 10 minutes ends a block and is not counted; exactly 10 still joins', () => {
  const t0 = at(18, 9)
  expect(blocksOf([t0, t0 + 5 * MIN, t0 + 15 * MIN, t0 + 26 * MIN])).toEqual([
    [t0, t0 + 15 * MIN],
    [t0 + 26 * MIN, t0 + 26 * MIN],
  ])
  const { rows } = tally(
    [act('s', 'p', t0), act('s', 'p', t0 + 5 * MIN), act('s', 'p', t0 + 15 * MIN), act('s', 'p', t0 + 26 * MIN)],
    periodOf('today', t0),
  )
  expect(rows[0]?.mine).toBe(15 * MIN)
})

test('overlapping blocks from parallel sessions count once; AI time from parallel sessions adds up', () => {
  const t0 = at(18, 10)
  const events = [
    act('a', 'acme-api', t0),
    act('a', 'acme-api', t0 + 8 * MIN),
    act('b', 'acme-api', t0 + 5 * MIN),
    act('b', 'acme-api', t0 + 12 * MIN),
    act('b', 'acme-api', t0 + 20 * MIN),
    turn('a', 'acme-api', t0, t0 + 30 * MIN),
    turn('b', 'acme-api', t0 + 5 * MIN, t0 + 35 * MIN),
  ]
  const { rows, mineTotal, aiTotal } = tally(events, periodOf('today', t0))
  expect(rows[0]?.mine).toBe(20 * MIN) // 10:00–10:20, not 8 + 15
  expect(rows[0]?.ai).toBe(60 * MIN) // 30 + 30, more than the 35 minutes of wall clock
  expect(rows[0]?.turns).toBe(2)
  expect(mineTotal).toBe(20 * MIN)
  expect(aiTotal).toBe(60 * MIN)
})

test('the end of an AI turn counts as your activity: reading the answer until the next prompt is your time', () => {
  const t0 = at(18, 11)
  // Prompt at 11:00, the AI works 25 minutes, you reply 6 minutes after it finished.
  const events = [act('s', 'p', t0), turn('s', 'p', t0, t0 + 25 * MIN), act('s', 'p', t0 + 31 * MIN)]
  expect(tally(events, periodOf('today', t0)).rows[0]?.mine).toBe(6 * MIN)
  // Away for longer than 10 minutes after the answer: that wait is not counted.
  const away = [act('s', 'p', t0), turn('s', 'p', t0, t0 + 25 * MIN), act('s', 'p', t0 + 40 * MIN)]
  expect(tally(away, periodOf('today', t0)).rows[0]?.mine).toBe(0)
})

test('the total of your time unites projects worked at the same moment', () => {
  const t0 = at(18, 14)
  const { rows, mineTotal } = tally(
    [
      act('a', 'acme-api', t0),
      act('a', 'acme-api', t0 + 10 * MIN),
      act('b', 'acme-web', t0 + 5 * MIN),
      act('b', 'acme-web', t0 + 15 * MIN),
    ],
    periodOf('today', t0),
  )
  expect(rows.map(r => r.mine)).toEqual([10 * MIN, 10 * MIN])
  expect(mineTotal).toBe(15 * MIN)
})

test('a block across midnight is split: each day gets its own part', () => {
  const late = at(17, 23, 55)
  const early = at(18, 0, 5)
  expect(splitByDay([[late, early]])).toEqual([
    [late, at(18, 0)],
    [at(18, 0), early],
  ])
  const events = [act('s', 'p', late), act('s', 'p', early), turn('s', 'p', late, early)]
  const today = tally(events, periodOf('today', at(18, 12)))
  expect(today.rows[0]?.mine).toBe(5 * MIN)
  expect(today.rows[0]?.ai).toBe(5 * MIN)
  expect(today.rows[0]?.turns).toBe(0) // the turn started yesterday
  const yesterday = tally(events, periodOf('today', at(17, 12)))
  expect(yesterday.rows[0]?.mine).toBe(5 * MIN)
  expect(yesterday.rows[0]?.turns).toBe(1)
})

test('week runs Monday to Sunday in local time; month is the calendar month', () => {
  expect(periodOf('week', at(18, 12))).toEqual([at(12, 0), at(19, 0)]) // Sunday belongs to the week that began Monday 12th
  expect(periodOf('week', at(19, 0, 1))).toEqual([at(19, 0), at(26, 0)]) // Monday starts a new one
  expect(periodOf('month', at(18, 12))).toEqual([at(1, 0), new Date(2026, 10, 1).getTime()])
  expect(periodOf('today', at(18, 23, 59))).toEqual([at(18, 0), at(19, 0)])
  // A week across two months reads both months' logs.
  expect(monthsOf(periodOf('week', new Date(2026, 9, 30, 12).getTime()))).toEqual(['2026-10', '2026-11'])
})

test('union merges overlapping and touching intervals only', () => {
  expect(
    union([
      [0, 10],
      [5, 20],
      [20, 25],
      [30, 40],
    ]),
  ).toEqual([
    [0, 25],
    [30, 40],
  ])
})

test('the table: XhYY or Ym, number columns right-aligned, sorted by your time, total line', () => {
  expect(fmtDuration(25 * MIN)).toBe('25m')
  expect(fmtDuration(6 * 60 * MIN + 40 * MIN)).toBe('6h40')
  const table = renderTable(
    [
      { project: 'acme-api', mine: 400 * MIN, ai: 850 * MIN, turns: 83, prompts: [], summary: 'API checkout, fix auth' },
      { project: 'acme-web', mine: 195 * MIN, ai: 350 * MIN, turns: 7, prompts: [], summary: '' },
    ],
    595 * MIN,
    1200 * MIN,
  )
  const lines = table.split('\n')
  expect(lines[0]).toBe('Project          Bạn làm   AI chạy   Lượt    Việc chính')
  expect(lines[1]).toBe('acme-api            6h40     14h10     83    API checkout, fix auth')
  expect(lines[2]).toBe('acme-web            3h15      5h50      7')
  expect(lines[3]?.startsWith('──────')).toBe(true)
  expect(lines[4]).toBe('Tổng                9h55     20h00')
  // Right-aligned: each duration ends in the same column as its header.
  expect((lines[1] ?? '').indexOf('6h40') + 4).toBe((lines[0] ?? '').indexOf('Bạn làm') + 7)
  const sorted = tally(
    [act('a', 'small', at(18, 9)), act('a', 'small', at(18, 9, 1)), act('b', 'big', at(18, 9)), act('b', 'big', at(18, 9, 9))],
    periodOf('today', at(18, 9)),
  )
  expect(sorted.rows.map(r => r.project)).toEqual(['big', 'small'])
})

test('a log line that does not parse is skipped', () => {
  const good = JSON.stringify(act('s', 'p', 1))
  expect(parseLog(`${good}\nnot json\n{"t":"act"}\n\n${good}`).length).toBe(2)
})
