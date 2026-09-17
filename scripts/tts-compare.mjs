// So sánh Gemini TTS với Edge TTS trên cùng một câu trộn Việt Anh.
// Chạy:  node scripts/tts-compare.mjs ["câu muốn đọc"] [--gemini-voices Kore,Puck] [--instruction "chỉ dẫn đọc"] [--tag ten] [--no-edge] [--no-play]
// Cần GEMINI_API_KEY trong .env ở gốc project (hoặc biến môi trường).
// Gói miễn phí của model TTS chỉ 15 request/ngày, mỗi giọng Gemini là một request.

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'scripts', 'out');

const DEFAULT_TEXT =
  'Tôi có một repo trên GitHub, nó có thể support Claude Code, lưu ý cần đọc file README.md trước khi làm.';

const GEMINI_MODEL = 'gemini-2.5-flash-preview-tts';
const EDGE_VOICES = ['vi-VN-HoaiMyNeural', 'en-US-AvaMultilingualNeural'];

function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function parseArgs(argv) {
  const opts = { text: DEFAULT_TEXT, geminiVoices: ['Kore', 'Puck'], play: true, instruction: '', edge: true, tag: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--gemini-voices') opts.geminiVoices = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--instruction') opts.instruction = argv[++i];
    else if (a === '--tag') opts.tag = argv[++i];
    else if (a === '--no-edge') opts.edge = false;
    else if (a === '--no-play') opts.play = false;
    else opts.text = a;
  }
  return opts;
}

/** PCM s16le mono -> WAV. */
function pcmToWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function geminiTts(text, voice, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  };
  const t0 = Date.now();
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const ms = Date.now() - t0;
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const data = await res.json();
  const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
  if (!part) throw new Error(`Không có audio trong response: ${JSON.stringify(data).slice(0, 400)}`);
  const mime = part.inlineData.mimeType || '';
  const rate = Number(/rate=(\d+)/.exec(mime)?.[1] ?? 24000);
  const pcm = Buffer.from(part.inlineData.data, 'base64');
  return { wav: pcmToWav(pcm, rate), ms, mime };
}

async function edgeTts(text, voice) {
  const tts = new MsEdgeTTS();
  const chunks = [];
  const t0 = Date.now();
  try {
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(text, { rate: '+0%' });
    await new Promise((resolve, reject) => {
      audioStream.on('data', (c) => chunks.push(c));
      audioStream.on('error', reject);
      audioStream.on('end', resolve);
    });
  } finally {
    tts.close();
  }
  return { mp3: Buffer.concat(chunks), ms: Date.now() - t0 };
}

function play(file) {
  const r = spawnSync('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', file], { stdio: 'inherit' });
  if (r.error) console.log(`  (không chạy được ffplay: ${r.error.message})`);
}

async function main() {
  loadEnv();
  const opts = parseArgs(process.argv.slice(2));
  const apiKey = process.env.GEMINI_API_KEY;
  fs.mkdirSync(OUT, { recursive: true });

  console.log(`Câu: ${opts.text}\n`);
  const files = [];

  for (const voice of opts.edge ? EDGE_VOICES : []) {
    process.stdout.write(`Edge ${voice} ... `);
    try {
      const { mp3, ms } = await edgeTts(opts.text, voice);
      const file = path.join(OUT, `edge-${voice}.mp3`);
      fs.writeFileSync(file, mp3);
      console.log(`${ms} ms, ${mp3.length} bytes -> ${path.relative(ROOT, file)}`);
      files.push({ label: `Edge ${voice}`, file });
    } catch (e) {
      console.log(`LỖI: ${e.message}`);
    }
  }

  if (!apiKey) {
    console.log('\nChưa có GEMINI_API_KEY trong .env, bỏ qua Gemini.');
  } else {
    for (const voice of opts.geminiVoices) {
      process.stdout.write(`Gemini ${GEMINI_MODEL} giọng ${voice} ... `);
      try {
        const input = opts.instruction ? `${opts.instruction}

${opts.text}` : opts.text;
        const { wav, ms, mime } = await geminiTts(input, voice, apiKey);
        const file = path.join(OUT, `gemini-${voice}${opts.tag ? '-' + opts.tag : ''}.wav`);
        fs.writeFileSync(file, wav);
        console.log(`${ms} ms, ${mime}, ${wav.length} bytes -> ${path.relative(ROOT, file)}`);
        files.push({ label: `Gemini ${voice}`, file });
      } catch (e) {
        console.log(`LỖI: ${e.message}`);
      }
    }
  }

  if (opts.play && files.length) {
    console.log('\nPhát lần lượt:');
    for (const f of files) {
      console.log(`  ▶ ${f.label}`);
      play(f.file);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
