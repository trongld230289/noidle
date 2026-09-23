/**
 * Xử lý một sự kiện hook của Claude Code: ghi hộp thư, và khi thích hợp trả JSON để Claude Code đọc.
 * Thuần: mọi thứ ngoài (thư mục, đồng hồ, đọc file, chờ quyết định từ web) được tiêm qua deps để test được.
 */
import * as fs from 'fs';
import { updateInbox, takeQueue, setFlag, takeFlag, appendEvent, Decision, Pending, HubEvent } from './inbox';
import { lastAssistantText, pickSpeech, workspaceName } from './transcript';
import { isDangerous, summarizeTool } from './danger';
import type { HubConfig } from './config';

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  prompt?: string;
  /** Có khi hook chạy trong subagent: không phải người dùng nói, bỏ qua. */
  agent_id?: string;
  agent_type?: string;
  transcript_path?: string;
  stop_hook_active?: boolean;
  tool_name?: string;
  tool_input?: {
    questions?: { question?: string; multiSelect?: boolean; options?: { label?: string }[] }[];
    [k: string]: unknown;
  };
  notification_type?: string;
  message?: string;
}

export interface HookDeps {
  dir: string;
  cfg: HubConfig;
  now?: () => number;
  readFile?: (p: string) => string;
  /** Chờ quyết định từ trang web cho phiên; undefined nếu không ai xem, hết giờ hay lỗi. */
  wait?: (session: string, pending: Pending) => Promise<Decision | undefined>;
  log?: (m: string) => void;
}

const OURS = 'ours';

function logEvent(deps: HookDeps, session: string, workspace: string, kind: HubEvent['kind'], text?: string): void {
  appendEvent(deps.dir, { at: (deps.now ?? Date.now)(), session, workspace, kind, text: text ? text.slice(0, 160) : undefined });
}
const MAX_PROMPT = 200;
const MAX_FULL = 8000;

export async function handleHook(event: string, input: HookInput, deps: HookDeps): Promise<object | undefined> {
  const session = input.session_id ?? '';
  if (!session) return undefined;
  const now = deps.now ?? Date.now;
  const cwd = input.cwd || process.cwd();
  const base = { cwd, workspace: workspaceName(cwd) };
  const log = deps.log ?? (() => undefined);

  switch (event) {
    case 'UserPromptSubmit': {
      if (input.agent_id) {
        log(`prompt của subagent ${input.agent_type ?? input.agent_id}, bỏ qua`);
        return undefined;
      }
      const prompt = typeof input.prompt === 'string' ? input.prompt.replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT) : '';
      updateInbox(deps.dir, session, { ...base, state: 'working', lastPrompt: prompt || undefined, clearPending: true }, now());
      logEvent(deps, session, base.workspace, 'prompt', prompt);
      return undefined;
    }

    case 'Stop': {
      // Hook khác vừa chặn Stop (Claude làm tiếp): không phải lượt kết thúc thật, trừ khi chính mình chặn ở lượt trước.
      if (input.stop_hook_active && !takeFlag(deps.dir, session, OURS)) return undefined;
      let spoken = '';
      let full = '';
      if (input.transcript_path) {
        try {
          full = lastAssistantText((deps.readFile ?? ((p) => fs.readFileSync(p, 'utf8')))(input.transcript_path)).trim();
          spoken = pickSpeech(full);
          if (full.length > MAX_FULL) full = full.slice(0, MAX_FULL) + '…';
        } catch (err) {
          log(`không đọc được transcript: ${(err as Error).message}`);
        }
      }
      const queued = takeQueue(deps.dir, session);
      if (queued) {
        updateInbox(deps.dir, session, { ...base, state: 'working', lastSpoken: spoken || undefined, lastFull: full || undefined, lastPrompt: queued.slice(0, MAX_PROMPT), clearQueued: true, clearPending: true }, now());
        setFlag(deps.dir, session, OURS);
        if (spoken) logEvent(deps, session, base.workspace, 'done', spoken);
        logEvent(deps, session, base.workspace, 'run', queued);
        log(`Stop: có lệnh xếp hàng, chặn dừng: ${JSON.stringify(queued.slice(0, 80))}`);
        return { decision: 'block', reason: queued };
      }
      updateInbox(deps.dir, session, { ...base, state: 'done', lastSpoken: spoken || undefined, lastFull: full || undefined, clearPending: true }, now());
      logEvent(deps, session, base.workspace, 'done', spoken);
      return undefined;
    }

    case 'PermissionRequest': {
      const pending: Pending = {
        kind: 'approve',
        toolName: input.tool_name,
        summary: summarizeTool(input.tool_name, input.tool_input),
        dangerous: isDangerous(input.tool_name, input.tool_input),
        since: now(),
      };
      updateInbox(deps.dir, session, { ...base, state: 'waiting_approve', pending }, now());
      logEvent(deps, session, base.workspace, 'approve', [pending.toolName, pending.summary].filter(Boolean).join(': '));
      const d = deps.wait ? await deps.wait(session, pending) : undefined;
      if (!d?.decision) return undefined;
      if (d.decision === 'allow' && pending.dangerous) {
        log('approve từ web bị bỏ qua vì lệnh nguy hiểm');
        return undefined;
      }
      updateInbox(deps.dir, session, { state: 'working', clearPending: true }, now());
      logEvent(deps, session, base.workspace, 'decided', d.decision);
      const decision: { behavior: 'allow' | 'deny'; message?: string } = { behavior: d.decision };
      if (d.decision === 'deny') decision.message = deps.cfg.lang === 'en' ? 'Denied by the user from the control page.' : 'Người dùng từ chối từ trang điều khiển.';
      return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
    }

    case 'PreToolUse': {
      if (input.tool_name !== 'AskUserQuestion') return undefined;
      const q = (input.tool_input?.questions ?? []).find((x) => x?.question);
      if (!q) return undefined;
      // Claude hay tự đánh số nhãn ("1. Tra tracking"); bỏ để trang không hiện số hai lần.
      const options = (q.options ?? []).map((o) => (o?.label ?? '').trim().replace(/^\d+[.):]\s*/, '')).filter(Boolean);
      const pending: Pending = { kind: 'question', question: q.question, options, multiSelect: !!q.multiSelect, since: now() };
      updateInbox(deps.dir, session, { ...base, state: 'waiting_answer', pending }, now());
      logEvent(deps, session, base.workspace, 'question', q.question);
      const d = deps.wait ? await deps.wait(session, pending) : undefined;
      if (d?.answer === undefined || d.answer === '') return undefined;
      const chosen = Array.isArray(d.answer)
        ? d.answer.map((i) => options[i]).filter(Boolean).map((c) => `"${c}"`).join(deps.cfg.lang === 'en' ? ' and ' : ' và ')
        : `"${String(d.answer).trim()}"`;
      if (!chosen) return undefined;
      updateInbox(deps.dir, session, { state: 'working', clearPending: true }, now());
      logEvent(deps, session, base.workspace, 'decided', chosen);
      const reason =
        deps.cfg.lang === 'en'
          ? `The user already answered from the control page, do not ask again. Question "${q.question}": ${Array.isArray(d.answer) ? 'chose' : 'answered'} ${chosen}. Continue with this choice.`
          : `Người dùng đã trả lời từ trang điều khiển, không cần hỏi lại. Câu hỏi "${q.question}": ${Array.isArray(d.answer) ? 'chọn' : 'trả lời'} ${chosen}. Hãy làm tiếp theo lựa chọn này.`;
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
    }

    case 'Notification': {
      if (input.notification_type !== 'elicitation_dialog') return undefined;
      const pending: Pending = { kind: 'question', question: input.message || (deps.cfg.lang === 'en' ? 'Waiting for your input' : 'Đang chờ bạn nhập'), since: now() };
      updateInbox(deps.dir, session, { ...base, state: 'waiting_answer', pending }, now());
      return undefined;
    }

    default:
      return undefined;
  }
}
