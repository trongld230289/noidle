"""Edit TEXT, then run this file to preview the current NoIdle settings."""

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


TEXT = """Bạn cập nhật extension rồi kiểm tra lại nhé.
SuperAdmin kiểm tra đơn hàng trên ShipNGo và Shippo. Hello
Please review the changes before deploying to production.
"""

ROOT = Path(__file__).resolve().parents[1]

NODE_PREVIEW = r"""
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ts = require('typescript');
const { buildSync } = require('esbuild');

function loadSource(file) {
  const compiled = buildSync({ entryPoints: [file], bundle: true, platform: 'node', format: 'cjs', write: false });
  const loaded = { exports: {} };
  new Function('module', 'exports', 'require', compiled.outputFiles[0].text)(loaded, loaded.exports, require);
  return loaded.exports;
}

async function synth(text, voice, rate) {
  const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
  const tts = new MsEdgeTTS();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
        const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const { audioStream } = tts.toStream(escaped, { rate });
        const chunks = [];
        await new Promise((resolve, reject) => {
          audioStream.on('data', chunk => chunks.push(chunk));
          audioStream.on('error', reject);
          audioStream.on('end', resolve);
        });
        const audio = Buffer.concat(chunks);
        if (!audio.length) throw new Error('Edge returned no audio');
        return audio;
      })(),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Edge TTS timeout after 25 seconds')), 25000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    tts.close();
  }
}

async function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const parsed = ts.parseConfigFileTextToJson(input.settings, fs.readFileSync(input.settings, 'utf8'));
  if (parsed.error) throw new Error('Invalid settings: ' + ts.flattenDiagnosticMessageText(parsed.error.messageText, ' '));
  const properties = require('./package.json').contributes.configuration.properties;
  const setting = name => parsed.config['noIdle.' + name] ?? properties['noIdle.' + name].default;
  const { pronounce } = loadSource('src/pronounce.ts');
  const { isAuto, detectLang, langOf, effectiveVoice } = loadSource('src/lang.ts');
  const configuredLanguage = input.language || setting('language');
  const language = isAuto(configuredLanguage) ? (detectLang(input.text) || 'vi') : langOf(configuredLanguage);
  const voice = effectiveVoice(input.voice || setting('voice'), language);
  const rate = input.rate || setting('voiceRate');
  const spoken = pronounce(input.text, setting('pronunciations'), language === 'vi');
  const ffmpeg = setting('ffmpegPath');
  const player = ffmpeg === 'ffmpeg' ? 'ffplay' : path.join(path.dirname(ffmpeg), 'ffplay' + path.extname(ffmpeg));
  console.log(JSON.stringify({ original: input.text, spoken, voice, rate, language, player }, null, 2));
  if (input.dryRun) return;
  let audio;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      audio = await synth(spoken, voice, rate);
      break;
    } catch (error) {
      if (attempt === 2) throw error;
      console.error('Retrying TTS: ' + error.message);
    }
  }
  console.log('Playing ' + audio.length + ' bytes...');
  const result = spawnSync(player, ['-nodisp', '-autoexit', '-loglevel', 'error', '-f', 'mp3', '-i', 'pipe:0'], {
    input: audio, windowsHide: true, timeout: 300000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('ffplay failed: ' + result.stderr.toString('utf8'));
  console.log('Playback completed.');
}

main().catch(error => { console.error('Preview failed: ' + error.message); process.exitCode = 1; });
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("text", nargs="?", help="Text to read; otherwise use TEXT at the top of this file")
    parser.add_argument("--file", type=Path, help="Read a UTF-8 text file instead of TEXT")
    parser.add_argument("--settings", type=Path, help="VS Code user/profile settings JSONC file")
    parser.add_argument("--voice", help="Temporary Edge voice ID; does not change Settings")
    parser.add_argument("--rate", help="Temporary rate, e.g. --rate=+10%%")
    parser.add_argument("--language", choices=["vi", "en", "auto"], help="Temporary language override")
    parser.add_argument("--dry-run", action="store_true", help="Show prepared text without network or audio")
    args = parser.parse_args()
    if args.file and args.text is not None:
        parser.error("Use either text or --file, not both")
    settings = args.settings
    if settings is None:
        appdata = os.environ.get("APPDATA")
        if not appdata:
            parser.error("Pass --settings when Windows APPDATA is unavailable")
        settings = Path(appdata) / "Code" / "User" / "settings.json"
    node = shutil.which("node")
    if not node:
        parser.error("Node.js is required; install it and add node to PATH")
    try:
        text = (args.file.read_text(encoding="utf-8-sig") if args.file else args.text if args.text is not None else TEXT).strip()
        if not text:
            parser.error("Text must not be empty")
        request = {
            "text": text,
            "settings": str(settings.resolve()),
            "voice": args.voice,
            "rate": args.rate,
            "language": args.language,
            "dryRun": args.dry_run,
        }
        result = subprocess.run(
            [node, "-e", NODE_PREVIEW],
            input=json.dumps(request, ensure_ascii=True).encode("utf-8"),
            cwd=ROOT,
            timeout=420,
            check=False,
        )
        return result.returncode
    except (OSError, UnicodeError, subprocess.TimeoutExpired) as error:
        print(f"Preview failed: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())