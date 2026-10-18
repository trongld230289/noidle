import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const norm = (p: string) => p.replace(/\\/g, '/')
const MIN = 60_000

/** A session in D:/Project/acme-api with an in-memory disk; counts the model calls. */
function world(on: On, options: { modelFails?: boolean } = {}) {
  const clock = mock.clock(on, { now: new Date(2026, 9, 18, 9, 0).getTime() })
  mock.env(on, { USERPROFILE: 'C:\\Users\\t' })
  const files = new Map<string, { text: string; at: number }>()
  const calls = { model: 0 }
  on('session.id', () => ({ value: 'sess-a' }))
  on('session.cwd', () => ({ value: 'D:/Project/acme-api/src' }))
  on('session.repo', () => ({ value: { root: 'D:/Project/acme-api', remote: null, internal: false, name: null } }))
  on('session.start', () => ({ cwd: 'D:/Project/acme-api/src' }))
  on('command.register', () => ({ value: undefined }) as never)
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', () => ({ turnId: 't' }))
  on('turn.complete', () => ({ text: '' }))
  on('fs.read', (_, e) => {
    const f = files.get(norm(e.path))
    return f ? { value: f.text } : { deny: 'missing' }
  })
  on('fs.write', (_, e) => {
    files.set(norm(e.path), { text: e.text, at: clock.now() })
    return { value: undefined }
  })
  on('fs.list', (_, e) => {
    const dir = `${norm(e.path)}/`
    const list = [...files.entries()].filter(([p]) => p.startsWith(dir) && !p.slice(dir.length).includes('/'))
    return {
      value: list.map(([p, f]) => ({ name: p.slice(dir.length), kind: 'file', size: f.text.length, mtimeMs: f.at, isLink: false })),
    } as never
  })
  on('model.complete', () => {
    calls.model += 1
    return options.modelFails
      ? { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE } as const }
      : { value: { isAnswered: true, text: '"API checkout, fix auth."', usage: USAGE } as const }
  })
  return { clock, files, calls }
}

const typed = (text: string) => ({ text, origin: { kind: 'composer' } }) as never

test('prompts, a turn and a plugin prompt are recorded; /timesheet prints the table with a summary', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: 'D:/Project/acme-api/src', surface: 'terminal', isInteractive: true } as never)

  await $.prompt.submit(typed('thêm API checkout'))
  await $.turn.start({ text: 'thêm API checkout', turnId: 't' } as never)
  await w.clock.advance(20 * MIN)
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 0, isAborted: false, turnId: 't' } as never)
  await w.clock.advance(5 * MIN)
  await $.prompt.submit(typed('fix lỗi auth'))
  // Not your gesture: a plugin's queued prompt does not count as your time.
  await w.clock.advance(5 * MIN)
  await $.prompt.submit({ text: 'from a queue', origin: { kind: 'plugin', name: 'glancedeck', asUser: true } } as never)

  const log = w.files.get('C:/Users/t/.timesheet/2026-10/sess-a.jsonl')?.text ?? ''
  expect(log.trim().split('\n').length).toBe(3) // two acts and one turn

  const out = await $.command.run({ command: 'timesheet', args: '' } as never)
  const lines = (out.text ?? '').split('\n')
  expect(lines[0]).toBe('Project          Bạn làm   AI chạy   Lượt    Việc chính')
  // The turn ends at 9:20 and you prompt again at 9:25: those 5 minutes are yours; the turn is 20m.
  expect(lines[1]).toBe('acme-api              5m       20m      1    API checkout, fix auth')
  expect(w.calls.model).toBe(1)

  // The same period, nothing new: the summary comes from the cache.
  await $.command.run({ command: 'timesheet', args: 'week' } as never)
  await $.command.run({ command: 'timesheet', args: 'week' } as never)
  expect(w.calls.model).toBe(2)
})

test('a failed model call leaves the summary empty and the command still answers', async ($, on) => {
  const w = world(on, { modelFails: true })
  await $.session.start({ cwd: 'D:/Project/acme-api/src', surface: 'terminal', isInteractive: true } as never)
  await $.prompt.submit(typed('một'))
  await w.clock.advance(4 * MIN)
  await $.prompt.submit(typed('hai'))

  const out = await $.command.run({ command: 'timesheet', args: 'month' } as never)
  expect((out.text ?? '').split('\n')[1]).toBe('acme-api              4m        0m      0')
})

test('no data and a wrong argument both answer plainly', async ($, on) => {
  world(on)
  expect((await $.command.run({ command: 'timesheet', args: '' } as never)).text).toBe('Chưa có dữ liệu cho hôm nay.')
  expect((await $.command.run({ command: 'timesheet', args: 'year' } as never)).text).toContain('Usage')
})
