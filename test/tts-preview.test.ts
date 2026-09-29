import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const script = path.resolve(__dirname, '../scripts/tts-preview.py');

function preview(args: string[]) {
  return spawnSync('python', [script, ...args], { encoding: 'utf8', timeout: 15_000, cwd: os.tmpdir() });
}

describe('Python TTS preview', () => {
  it('reads JSONC settings afresh and shares the extension pronunciation rules', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noidle-preview-'));
    try {
      const settings = path.join(dir, 'settings.json');
      fs.writeFileSync(settings, `{
        // User settings allow comments and trailing commas.
        "noIdle.voice": "en-US-BrianMultilingualNeural",
        "noIdle.language": "vi",
        "noIdle.voiceRate": "+10%",
        "noIdle.pronunciations": { "extension": "ex tension", "AcmeShop": "Acme Shop", "API": "", },
      }`);
      const text = 'Bạn kiểm tra extension AcmeShop API và rapid.';
      const result = preview(['--settings', settings, '--dry-run', text]);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        original: text,
        spoken: 'Bạn kiểm tra ex tension Acme Shop API và rapid.',
        voice: 'en-US-BrianMultilingualNeural',
        rate: '+10%',
        language: 'vi',
      });
      fs.writeFileSync(settings, JSON.stringify({ 'noIdle.pronunciations': { extension: 'new reading' } }));
      expect(JSON.parse(preview(['--settings', settings, '--dry-run', 'extension']).stdout).spoken).toBe('new reading');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads a UTF-8 file, detects English and allows a temporary voice override', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noidle-preview-'));
    try {
      const settings = path.join(dir, 'settings.json');
      const textFile = path.join(dir, 'sample.txt');
      fs.writeFileSync(settings, JSON.stringify({ 'noIdle.language': 'auto', 'noIdle.voice': 'vi-VN-HoaiMyNeural' }));
      fs.writeFileSync(textFile, '\ufeffPlease check the extension & API <test>.');
      const args = ['--settings', settings, '--file', textFile, '--dry-run'];
      const result = preview(args);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        voice: 'en-US-AvaMultilingualNeural', language: 'en', spoken: 'Please check the extension & API <test>.',
      });
      const override = preview([...args, '--voice', 'en-US-BrianMultilingualNeural']);
      expect(JSON.parse(override.stdout).voice).toBe('en-US-BrianMultilingualNeural');
      expect(JSON.parse(fs.readFileSync(settings, 'utf8'))['noIdle.voice']).toBe('vi-VN-HoaiMyNeural');
      fs.writeFileSync(settings, '{ invalid JSON');
      const invalid = preview(args);
      expect(invalid.status).not.toBe(0);
      expect(invalid.stderr).toContain('settings');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});