/**
 * Hook cho Claude Code, đóng gói thành dist/claude-hook.js. Ba chế độ:
 *   prompt                    UserPromptSubmit: in hướng dẫn để Claude kết thúc bằng dòng 🔊.
 *   speak [--voice] [--rate] [--player]
 *                             Stop: đọc transcript, chọn câu cần đọc, rồi tách tiến trình `play` và thoát ngay.
 *   play <textfile> [...]     Tổng hợp giọng bằng Edge TTS, phát bằng ffplay. Tắt lượt đọc trước nếu còn.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { lastAssistantText, pickSpeech, PROMPT_CONTEXT } from './speech';

const DEFAULT_VOICE = 'vi-VN-HoaiMyNeural';
const WORK_DIR = path.join(os.tmpdir(), 'vi-voice-tts');
const PID_FILE = path.join(WORK_DIR, 'playing.json');
const LOG_FILE = path.join(WORK_DIR, 'hook.log');

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function log(msg: string): void {
  try {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* bỏ qua */
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (data += d));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    setTimeout(() => resolve(data), 3000);
  });
}

function killPrevious(): void {
  try {
    const prev = JSON.parse(fs.readFileSync(PID_FILE, 'utf8')) as { node?: number; player?: number };
    for (const pid of [prev.player, prev.node]) {
      if (pid && pid !== process.pid) {
        try {
          process.kill(pid);
        } catch {
          /* đã thoát */
        }
      }
    }
  } catch {
    /* chưa có */
  }
}

async function modePrompt(): Promise<void> {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: PROMPT_CONTEXT } }),
  );
}

async function modeSpeak(): Promise<void> {
  const input = JSON.parse((await readStdin()) || '{}') as { transcript_path?: string; stop_hook_active?: boolean };
  if (input.stop_hook_active || !input.transcript_path) return;
  let transcript: string;
  try {
    transcript = fs.readFileSync(input.transcript_path, 'utf8');
  } catch (err) {
    log(`không đọc được transcript: ${(err as Error).message}`);
    return;
  }
  const text = pickSpeech(lastAssistantText(transcript));
  if (!text) return;
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const file = path.join(WORK_DIR, `say-${Date.now()}.txt`);
  fs.writeFileSync(file, text, 'utf8');
  const child = spawn(
    process.execPath,
    [__filename, 'play', file, '--voice', arg('voice', DEFAULT_VOICE), '--rate', arg('rate', '+0%'), '--player', arg('player', 'ffplay')],
    { detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.unref();
  log(`speak → play pid ${child.pid}: ${JSON.stringify(text)}`);
}

async function modePlay(): Promise<void> {
  const file = process.argv[3];
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text) return;
  fs.mkdirSync(WORK_DIR, { recursive: true });
  killPrevious();
  fs.writeFileSync(PID_FILE, JSON.stringify({ node: process.pid }));

  const tts = new MsEdgeTTS();
  await tts.setMetadata(arg('voice', DEFAULT_VOICE), OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { audioFilePath } = await tts.toFile(WORK_DIR, text, { rate: arg('rate', '+0%') });
  tts.close();
  log(`tts ok ${audioFilePath} (${fs.statSync(audioFilePath).size} bytes)`);

  await new Promise<void>((resolve) => {
    const player = spawn(arg('player', 'ffplay'), ['-nodisp', '-autoexit', '-loglevel', 'quiet', audioFilePath], {
      stdio: 'ignore',
      windowsHide: true,
    });
    fs.writeFileSync(PID_FILE, JSON.stringify({ node: process.pid, player: player.pid }));
    player.on('error', (e) => {
      log(`không chạy được player: ${e.message}`);
      resolve();
    });
    player.on('exit', () => resolve());
  });
  try {
    fs.unlinkSync(audioFilePath);
    fs.unlinkSync(file);
  } catch {
    /* bỏ qua */
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === 'prompt') return modePrompt();
  if (mode === 'speak') return modeSpeak();
  if (mode === 'play') return modePlay();
  process.stderr.write('usage: claude-hook.js prompt | speak | play <file>\n');
  process.exitCode = 2;
}

main().catch((err) => {
  log(`lỗi ${process.argv[2]}: ${(err as Error).stack ?? err}`);
  // Hook không được làm Claude Code lỗi theo.
  process.exitCode = 0;
});
