// So chất lượng và số token của bước sửa câu trên các cụm giống chữ thô Whisper.
// Chạy: node scripts/refine-bench.mjs [label]   (cần noIdle.groqApiKey trong settings.json hoặc GROQ_KEY)
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { refine } = require('../src/refiner.ts');
const label = process.argv[2] || 'run';
const settings = fs.readFileSync('C:/Users/Admin/AppData/Roaming/Code/User/settings.json', 'utf8');
const apiKey = process.env.GROQ_KEY || (settings.match(/"noIdle.groqApiKey":\s*"([^"]+)"/) || [])[1];
const CASES = [
  ['terminal', '', 'sửa lại hàm claim next cho nó trả về null khi không có order'],
  ['chat', '', 'tạo một cái bất tính ở góc phải màn hình để mở popup'],
  ['terminal', '', 'commit rồi push lên nhánh feature vi voice'],
  ['chat', '', 'cái này có bị impact gì tới phần invoice import không'],
  ['terminal', 'sửa xong rồi', 'chạy unit test lại coi pass hết chưa'],
  ['chat', '', 'đọc file rít mi trước khi làm nha'],
  ['chat', '', 'hỏi copilot xem cái api này trả json hay xml'],
  ['chat', 'mình đang xem phần order view', 'ừm để mình xem lại đã'],
  ['chat', '', 'à à ừ'],
  ['chat', '', 'mở cái setting du ai lên cho mình'],
  ['editor', '', 'thêm dòng comment giải thích vì sao phải lock ở đây'],
  ['chat', 'tạo cho mình một cái form', 'có ba trường là tên email và số điện thoại'],
];
let promptTokens = 0, completionTokens = 0, calls = 0, ms = 0;
const fetchFn = async (url, init) => {
  const res = await fetch(url, init);
  const clone = res.clone();
  try { const j = await clone.json(); if (j.usage) { promptTokens += j.usage.prompt_tokens; completionTokens += j.usage.completion_tokens; calls++; } } catch {}
  return res;
};
const rows = [];
for (const [target, context, text] of CASES) {
  const t0 = Date.now();
  const out = await refine(text, { apiKey, target, context, glossary: ['claimNext', 'order view', 'impact'], fetchFn });
  ms += Date.now() - t0;
  rows.push({ text, out });
  console.log(`${text}\n   -> ${JSON.stringify(out)}`);
}
console.log(`\n[${label}] ${calls} lần gọi · trung bình ${Math.round(promptTokens / calls)} token vào + ${Math.round(completionTokens / calls)} token ra · ${Math.round(ms / calls)} ms/lần`);
fs.writeFileSync(`scripts/out/refine-${label}.json`, JSON.stringify({ promptTokens, completionTokens, calls, ms, rows }, null, 2));
