/**
 * Copilot Chat gọi hook PreToolUse trước mọi tool, kể cả tool sẽ tự duyệt, và không có sự kiện "hộp duyệt đã hiện".
 * Ép hộp thoại bằng permissionDecision 'ask' thì VS Code ẩn menu "Allow in this session / workspace / always", nên
 * thay vào đó extension chờ một lát và tìm bằng chứng tool đã chạy:
 *   - terminal của Copilot mở (Chat tạo terminal khi tool chạy, tức sau khi duyệt),
 *   - một lệnh bắt đầu chạy trong terminal (shell integration) khớp câu lệnh đang chờ, hay bất kỳ lệnh nào trong
 *     terminal Copilot,
 *   - hook PostToolUse báo xong (chatDone),
 *   - người dùng gửi prompt mới trong phiên đó.
 * Không có gì sau waitMs thì hộp duyệt đang hiện thật: đọc "cần approve" và nháy cửa sổ.
 */

export interface PendingChatTool {
  session: string;
  toolUseId?: string;
  command: string;
  text: string;
}

export interface ChatPendingOptions {
  /** Chờ bao lâu trước khi coi là hộp duyệt đang hiện. */
  waitMs?: number;
  onAnnounce: (pending: PendingChatTool) => void;
  log?: (message: string) => void;
}

export const DEFAULT_CHAT_PENDING_WAIT_MS = 2500;

const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Lệnh đang chờ khớp dòng lệnh shell integration báo: dòng đó bắt đầu bằng cả câu lệnh (VS Code có thể nối thêm). */
export function commandMatches(pending: string, commandLine: string): boolean {
  const p = normalize(pending);
  const line = normalize(commandLine);
  if (!p || !line) return false;
  return line === p || line.startsWith(`${p} `);
}

/** Terminal do Copilot Chat tạo: env có COPILOT_AGENT=1 hoặc AI_AGENT (VS Code 1.138). */
export function isAgentTerminal(options: { env?: Record<string, string | null | undefined> | null; name?: string } | undefined): boolean {
  const env = options?.env;
  if (!env) return false;
  return env.COPILOT_AGENT === '1' || typeof env.AI_AGENT === 'string';
}

export class ChatPendingTracker {
  private readonly items = new Map<string, { pending: PendingChatTool; timer: NodeJS.Timeout }>();
  private readonly waitMs: number;
  private seq = 0;

  constructor(private readonly o: ChatPendingOptions) {
    this.waitMs = o.waitMs ?? DEFAULT_CHAT_PENDING_WAIT_MS;
  }

  get size(): number {
    return this.items.size;
  }

  add(pending: PendingChatTool): void {
    const key = pending.toolUseId || `${pending.session}#${++this.seq}`;
    this.remove(key);
    const timer = setTimeout(() => {
      this.items.delete(key);
      this.o.log?.(`chat pending: hết ${this.waitMs}ms không thấy tool chạy, đọc "cần approve" cho ${JSON.stringify(pending.command)}`);
      this.o.onAnnounce(pending);
    }, this.waitMs);
    this.items.set(key, { pending, timer });
  }

  /** PostToolUse: khớp theo id, thiếu id thì theo phiên và câu lệnh. */
  done(ref: { toolUseId?: string; session?: string; command?: string }): void {
    for (const [key, { pending }] of this.items) {
      const byId = !!ref.toolUseId && pending.toolUseId === ref.toolUseId;
      const byCommand = !ref.toolUseId && pending.session === ref.session && normalize(pending.command) === normalize(ref.command ?? '');
      if (byId || byCommand) this.remove(key, 'tool đã chạy xong');
    }
  }

  terminalOpened(agentTerminal: boolean): void {
    if (agentTerminal) this.removeAll('terminal Copilot mở');
  }

  executionStarted(commandLine: string, agentTerminal: boolean): void {
    let matched = false;
    for (const [key, { pending }] of this.items) {
      if (commandMatches(pending.command, commandLine)) {
        this.remove(key, 'lệnh bắt đầu chạy');
        matched = true;
      }
    }
    if (!matched && agentTerminal) this.removeAll('lệnh khác chạy trong terminal Copilot');
  }

  promptSubmitted(session: string): void {
    for (const [key, { pending }] of this.items) if (pending.session === session) this.remove(key, 'người dùng gửi prompt mới');
  }

  clear(): void {
    this.removeAll();
  }

  private remove(key: string, why?: string): void {
    const item = this.items.get(key);
    if (!item) return;
    clearTimeout(item.timer);
    this.items.delete(key);
    if (why) this.o.log?.(`chat pending: ${why}, không đọc ${JSON.stringify(item.pending.command)}`);
  }

  private removeAll(why?: string): void {
    for (const key of [...this.items.keys()]) this.remove(key, why);
  }
}
