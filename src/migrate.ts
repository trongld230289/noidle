/**
 * Đổi tên 1.x → 2.0: id setting viVoice.* thành noIdle.*. Tính xem cần chép giá trị nào sang id mới và xoá id cũ nào;
 * phần ghi thật (VS Code API) nằm ở extension.ts để hàm này test được không cần vscode.
 */
export interface MigrationPlan {
  /** [key, value] cần ghi vào id mới (chỉ khi id mới chưa có giá trị). */
  set: [string, unknown][];
  /** Các key cũ cần xoá sau khi chép. */
  clear: string[];
}

export function planMigration(keys: readonly string[], oldValue: (key: string) => unknown, newValue: (key: string) => unknown): MigrationPlan {
  const plan: MigrationPlan = { set: [], clear: [] };
  for (const key of keys) {
    const old = oldValue(key);
    if (old === undefined) continue;
    if (newValue(key) === undefined) plan.set.push([key, old]);
    plan.clear.push(key);
  }
  return plan;
}

type ConfigBlock = { title?: string; properties?: Record<string, unknown> };

/** Gộp mọi setting khai báo trong contributes.configuration, dạng một khối hay mảng nhiều nhóm có tiêu đề. */
export function configProperties(contributes: { configuration?: ConfigBlock | ConfigBlock[] } | undefined): Record<string, unknown> {
  const c = contributes?.configuration;
  if (!c) return {};
  const blocks = Array.isArray(c) ? c : [c];
  return Object.assign({}, ...blocks.map((b) => b.properties ?? {}));
}

/**
 * 1.0.19: bỏ noIdle.voiceMute; Voice Response tắt giờ là im lặng (vẫn nháy, có hiệu lực ngay). Người đang mute thì
 * chuyển thành voiceResponse tắt; giá trị voiceMute nào cũng được xoá.
 */
export function planMuteMigration(mute: boolean | undefined): { voiceResponse?: false; clearMute: boolean } {
  if (mute === undefined) return { clearMute: false };
  return mute ? { voiceResponse: false, clearMute: true } : { clearMute: true };
}
