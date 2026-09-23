/**
 * Sửa chữ trước khi đọc để giọng tiếng Việt của Edge (HoaiMy, NamMinh) phát âm đúng thuật ngữ tiếng Anh.
 * Giọng vi-VN đọc chữ viết tắt theo tên chữ cái tiếng Việt ("MD" thành "mờ đờ") hoặc bỏ qua, nên ta viết
 * sẵn tên chữ cái tiếng Anh bằng âm tiết tiếng Việt: ".md" thành "chấm em đi", "API" thành "ây pi ai".
 *
 * Khoá bắt đầu bằng "." là phần mở rộng file: chỉ thay khi dính ngay sau tên file (README.md), không thay
 * dấu chấm cuối câu. Khoá khác thay theo nguyên từ, không phân biệt hoa thường, không đụng vào chữ nằm
 * trong từ khác ("rapid" giữ nguyên dù chứa "api").
 */

export const DEFAULT_PRONUNCIATIONS: Record<string, string> = {
  // Phần mở rộng file
  '.md': 'chấm em đi',
  '.ts': 'chấm ti ét',
  '.tsx': 'chấm ti ét ích',
  '.js': 'chấm giây ét',
  '.jsx': 'chấm giây ét ích',
  '.json': 'chấm chây sơn',
  '.py': 'chấm pai',
  '.env': 'chấm en vi',
  '.yml': 'chấm da mồ',
  '.yaml': 'chấm da mồ',
  '.css': 'chấm xi ét ét',
  '.html': 'chấm ét ti em eo',
  '.sql': 'chấm ét kiu eo',
  '.csv': 'chấm xi ét vi',
  '.txt': 'chấm tếch',
  '.cs': 'chấm xi sáp',
  // Chữ viết tắt
  API: 'ây pi ai',
  UI: 'diu ai',
  UX: 'diu ích',
  URL: 'diu a eo',
  JSON: 'chây sơn',
  HTML: 'ét ti em eo',
  CSS: 'xi ét ét',
  SQL: 'ét kiu eo',
  SSH: 'ét ét ách',
  HTTP: 'ếch ti ti pi',
  HTTPS: 'ếch ti ti pi ét',
  ID: 'ai đi',
  IDE: 'ai đi i',
  CLI: 'xi eo ai',
  'CI/CD': 'xi ai xi đi',
  CI: 'xi ai',
  PR: 'pi a',
  DB: 'đi bi',
  SDK: 'ét đi kây',
  CSV: 'xi ét vi',
  PDF: 'pi đi ép',
  AI: 'ây ai',
  LLM: 'eo eo em',
  TTS: 'ti ti ét',
  STT: 'ét ti ti',
  MCP: 'em xi pi',
  npm: 'en pi em',
  'VS Code': 'vi ét cốt',
  GitHub: 'ghít háp',
  BE: 'bi i',
  FE: 'ép i',
  IPv4: 'ai pi vê four',
  IPv6: 'ip vê six',
  QA: 'kiu ây',
  // Tên riêng hay gặp mà giọng vi-VN đọc lệch
  Claude: 'cờ lốt',
  Gemini: 'giê mi nai',
  Copilot: 'cô pai lợt',
  Groq: 'grốc',
  Whisper: 'guýt pơ',
  Azure: 'a giơ',
  DevOps: 'đép óp',
  'Azure DevOps': 'a giơ đép óp',
  FedEx: 'phét ếch',
  Bash: 'bát',
  agent: 'ơ chần',
  agents: 'ơ chần',
  subagent: 'súp ơ chần',
  subagents: 'súp ơ chần',
  // Từ lập trình hay gặp: giọng vi-VN đọc tiếng Anh theo cơ chế dự phòng, nghe lơ lớ hoặc nuốt âm.
  // Người dùng có thể tắt từng mục bằng cách đặt giá trị rỗng trong noIdle.pronunciations.
  git: 'ghít',
  commit: 'com mít',
  push: 'pút',
  pull: 'pun',
  merge: 'mợt',
  master: 'mát tơ',
  branch: 'bờ ranh',
  conflict: 'con phờ lích',
  stash: 'sờ tát',
  rebase: 'ri bây',
  checkout: 'chéc ao',
  repo: 'rê pô',
  import: 'im pót',
  export: 'ếch pót',
  invoice: 'ình voi',
  popup: 'póp úp',
  dialog: 'đai lóc',
  build: 'biu',
  deploy: 'đi ploi',
  release: 'ri lít',
  refactor: 'ri phác tơ',
  hook: 'húc',
  config: 'con phích',
  setting: 'sét ting',
  settings: 'sét ting',
  appsettings: 'áp sét ting',
  backend: 'bách en',
  frontend: 'phờ răn en',
  server: 'sơ vơ',
  client: 'cờ lai ừn',
  database: 'đa ta bây',
  token: 'tô cừn',
  prompt: 'prom',
  cache: 'cát',
  request: 'ri quét',
  response: 'ri spon',
  function: 'phăng sần',
  test: 'tét',
  debug: 'đi bấc',
  bug: 'bấc',
  log: 'lốc',
  error: 'e rờ',
  feature: 'phi chơ',
  update: 'úp đết',
  upgrade: 'úp grết',
  install: 'in xtôn',
  package: 'pác kịt',
  module: 'mô đun',
  component: 'com pô nần',
  endpoint: 'en poin',
  workspace: 'guốc pây',
  terminal: 'tơ mi nồ',
  extension: 'ếch ten sần',
  plugin: 'pờ lấc in',
  script: 'sờ críp',
  support: 'sắp pót',
  approve: 'a pờ rúp',
  null: 'nâu',
  bool: 'bun',
  boolean: 'bu li ừn',
  string: 'sờ tring',
  key: 'ki',
  pronunciation: 'prô nân xi ây sừn',
  pronunciations: 'prô nân xi ây sừn',
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** Ký tự thuộc từ: chữ (mọi ngôn ngữ) và số. Không dùng \b vì nó coi chữ có dấu như "ủ" là ranh giới. */
const WORD = '[\\p{L}\\p{N}]';

/** Một regex gộp mọi khoá, thay trong một lượt để chữ vừa sinh ra ("ai" trong "ây pi ai") không bị luật khác bắt tiếp. */
interface Rules {
  pattern: RegExp;
  spoken: Map<string, string>;
}

function buildRules(map: Record<string, string>): Rules {
  const entries = Object.entries(map)
    .map(([key, spoken]) => [key.trim(), (spoken ?? '').trim()] as const)
    .filter(([key, spoken]) => key && spoken)
    // Khoá dài trước để "CI/CD" thắng "CI", ".tsx" thắng ".ts".
    .sort((a, b) => b[0].length - a[0].length);
  const alt = (keys: string[]) => keys.map(escapeRegExp).join('|');
  const ext = entries.filter(([k]) => k.startsWith('.')).map(([k]) => k);
  const word = entries.filter(([k]) => !k.startsWith('.')).map(([k]) => k);
  const parts: string[] = [];
  // Phần mở rộng: đứng ngay sau tên file và không có chữ/số đi tiếp (để ".md" không ăn ".mdx").
  if (ext.length) parts.push(`(?<=${WORD})(?:${alt(ext)})(?!${WORD})`);
  if (word.length) parts.push(`(?<!${WORD})(?:${alt(word)})(?!${WORD})`);
  return {
    pattern: new RegExp(parts.join('|') || '(?!)', 'giu'),
    spoken: new Map(entries.map(([k, v]) => [k.toLowerCase(), v])),
  };
}

const defaultRules = buildRules(DEFAULT_PRONUNCIATIONS);

/**
 * Thay thuật ngữ trong text bằng cách đọc. extra: bảng của người dùng, ghi đè bảng mặc định theo khoá.
 * useDefaults=false (đọc tiếng Anh): bỏ bảng mặc định vì nó phiên âm sang tiếng Việt, chỉ dùng bảng của người dùng.
 */
export function pronounce(text: string, extra?: Record<string, string>, useDefaults = true): string {
  // Khoá trống bị bỏ; giá trị rỗng nghĩa là tắt mục mặc định đó, từ được đọc như viết.
  const own = Object.entries(extra ?? {}).filter(([k]) => k.trim());
  const base = useDefaults ? DEFAULT_PRONUNCIATIONS : {};
  const { pattern, spoken } = own.length || !useDefaults ? buildRules({ ...base, ...Object.fromEntries(own) }) : defaultRules;
  return text.replace(pattern, (term) => {
    const say = spoken.get(term.toLowerCase());
    if (say === undefined) return term;
    return term.startsWith('.') ? ` ${say}` : say;
  });
}
