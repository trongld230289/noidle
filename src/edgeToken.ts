/**
 * Token Sec-MS-GEC v2 mà dịch vụ đọc của Edge đòi từ 24/10/2026: msedge-tts 2.1.0 vẫn gửi token v1 (SHA-256 thường), dịch vụ
 * trả 'Unexpected server response: 200', mọi câu đọc lỗi và status bar báo 'no voice'. Port từng dòng từ python edge-tts
 * 7.3.1 (edge_tts/drm.py), dùng BigInt như số nguyên Python; test/edgeToken.test.ts giữ token bản đó in ra.
 */

const M = 0xffffffffn;
const WIN_EPOCH = 11644473600;
export const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
export const SEC_MS_GEC_VERSION = '2-143.0.3650.75';

const INITIAL = [0x6a09e667n, 0xbb67ae85n, 0x3c6ef372n, 0xa54ff53an, 0x510e527fn, 0x9b05688cn, 0x1f83d9abn, 0x5be0cd19n];
const STATE = [0xfd9fbea2n, 0x91243ce7n, 0xbe499094n, 0xcd2e1e0an, 0x6c006f49n, 0x04bd35abn, 0xfeb0a7e4n, 0x03effbd2n];
const SCHEDULE = [0xeb24bf9en, 0x1558691fn, 0xa0c09ee2n, 0x0cfa32ban, 0xa622ee8cn, 0xd1dd9491n, 0xc0dd25a0n, 0xf9e70ab6n,
  0xf0c31573n, 0x7058ce4en, 0x7188e606n, 0x00e5ab33n, 0xd258b060n, 0x72766564n];
const K = [
  0x428a2f98n, 0x71374491n, 0xb5c0fbcfn, 0xe9b5dba5n, 0x3956c25bn, 0x59f111f1n, 0x923f82a4n, 0xab1c5ed5n,
  0xd807aa98n, 0x12835b01n, 0x243185ben, 0x550c7dc3n, 0x72be5d74n, 0x80deb1fen, 0x9bdc06a7n, 0xc19bf174n,
  0xe49b69c1n, 0xefbe4786n, 0x0fc19dc6n, 0x240ca1ccn, 0x2de92c6fn, 0x4a7484aan, 0x5cb0a9dcn, 0x76f988dan,
  0x983e5152n, 0xa831c66dn, 0xb00327c8n, 0xbf597fc7n, 0xc6e00bf3n, 0xd5a79147n, 0x06ca6351n, 0x14292967n,
  0x27b70a85n, 0x2e1b2138n, 0x4d2c6dfcn, 0x53380d13n, 0x650a7354n, 0x766a0abbn, 0x81c2c92en, 0x92722c85n,
  0xa2bfe8a1n, 0xa81a664bn, 0xc24b8b70n, 0xc76c51a3n, 0xd192e819n, 0xd6990624n, 0xf40e3585n, 0x106aa070n,
  0x19a4c116n, 0x1e376c08n, 0x2748774cn, 0x34b0bcb5n, 0x391c0cb3n, 0x4ed8aa4an, 0x5b9cca4fn, 0x682e6ff3n,
  0x748f82een, 0x78a5636fn, 0x84c87814n, 0x8cc70208n, 0x90befffan, 0xa4506cebn, 0xbef9a3f7n, 0xc67178f2n,
];
const ADJUSTMENT = 0xc9dc06a7n;
const BLOCK_K = [...K.slice(0, 14), ADJUSTMENT, ...K.slice(15)];
const SIGMA0_ADJUSTMENT = 0x059c0b80n;
const SIGMA1_ADJUSTMENT = 0x000b92c0n;
const CS64: [bigint, bigint][] = [
  [0xe82e91b1n, 0xb32700d0n], [0x44de24c6n, 0x88dff51dn], [0x3beb65bcn, 0x29514038n], [0xc89c5933n, 0xb328cbdfn],
  [0x8d1ec211n, 0xd405b4d5n], [0x314ef5d5n, 0x26e55f3cn], [0xe92491b1n, 0x607801c6n], [0xf0a5b9d5n, 0x82b2c1fbn],
  [0x06064cf3n, 0xfa51a3dan], [0xda79fa60n, 0x207cc464n], [0xbed20560n, 0x3c3c74f3n], [0x89f9c9f8n, 0xd2d14b61n],
  [0x35fa38c6n, 0xbb04a2c1n], [0xcb49e3c6n, 0xc5626167n],
];
const CS64_FACTOR = 0x82893933n;
const CS64_ADJUSTMENT0 = 0xf2f90b1an;
const CS64_ADJUSTMENT1 = 0x0b1a0000n;

const rotr = (x: bigint, n: bigint) => ((x >> n) | (x << (32n - n))) & M;
const rol16 = (x: bigint) => (((x & M) << 16n) | ((x & M) >> 16n)) & M;
const sigma0 = (x: bigint) => rotr(x, 7n) ^ rotr(x, 18n) ^ (x >> 3n);
const sigma1 = (x: bigint) => rotr(x, 17n) ^ rotr(x, 19n) ^ (x >> 10n);

function expand(w: bigint[], first = 16): void {
  for (let i = first; i < 64; i++) w.push((sigma1(w[i - 2]) + w[i - 7] + sigma0(w[i - 15]) + w[i - 16]) & M);
}

function rounds(state: bigint[], w: bigint[], first = 0): bigint[] {
  let [a, b, c, d, e, f, g, h] = state;
  const k = first === 14 ? BLOCK_K : K;
  for (let i = first; i < 64; i++) {
    const t1 = h + (rotr(e, 6n) ^ rotr(e, 11n) ^ rotr(e, 25n)) + (g ^ (e & (f ^ g))) + k[i] + w[i];
    const t2 = (rotr(a, 2n) ^ rotr(a, 13n) ^ rotr(a, 22n)) + ((a & b) | (c & (a | b)));
    [a, b, c, d, e, f, g, h] = [(t1 + t2) & M, a, b, c, (d + t1) & M, e, f, g];
  }
  return [a, b, c, d, e, f, g, h];
}

const be = (bytes: Uint8Array, at: number, n: number) => { let v = 0n; for (let i = 0; i < n; i++) v = (v << 8n) | BigInt(bytes[at + i]); return v; };

/** Trạng thái SHA-256 sau bảy byte đầu, từ midstate riêng của dịch vụ. */
function init(head: Uint8Array): bigint[] {
  const w: bigint[] = [...Array(14).fill(0n), be(head, 0, 3), be(head, 3, 4)];
  for (let i = 16; i < 30; i++) {
    let v = SCHEDULE[i - 16];
    if (i - 2 >= 14) v += i === 16 ? sigma1(w[i - 2]) ^ SIGMA1_ADJUSTMENT : sigma1(w[i - 2]);
    if (i - 7 >= 14) v += w[i - 7];
    if (i - 15 >= 14) v += i === 29 ? sigma0(w[i - 15]) ^ SIGMA0_ADJUSTMENT : sigma0(w[i - 15]);
    w.push(v & M);
  }
  w.push((sigma1(w[28]) + w[23] + sigma0(w[15]) + w[14] + ADJUSTMENT - K[14]) & M);
  expand(w, 31);
  const working = rounds(STATE, w, 14);
  return INITIAL.map((x, i) => (x + working[i]) & M);
}

function sha256(data: Uint8Array): Uint8Array {
  const length = 57 + data.length;
  const zeros = (((55 - length) % 64) + 64) % 64;
  const padded = new Uint8Array(data.length - 7 + 1 + zeros + 8);
  padded.set(data.subarray(7));
  padded[data.length - 7] = 0x80;
  new DataView(padded.buffer).setBigUint64(padded.length - 8, BigInt(length * 8));
  let state = init(data.subarray(0, 7));
  for (let off = 0; off < padded.length; off += 64) {
    const w: bigint[] = [];
    for (let i = 0; i < 16; i++) w.push(be(padded, off + i * 4, 4));
    expand(w);
    const working = rounds(state, w);
    state = state.map((x, i) => (x + working[i]) & M);
  }
  const out = new Uint8Array(32);
  state.forEach((x, i) => new DataView(out.buffer).setUint32(i * 4, Number(x)));
  return out;
}

function wordsLe4Even(data: Uint8Array): bigint[] {
  const padded = new Uint8Array(Math.ceil(data.length / 4) * 4);
  padded.set(data);
  const dv = new DataView(padded.buffer);
  const words: bigint[] = [];
  for (let i = 0; i < padded.length; i += 4) words.push(BigInt(dv.getUint32(i, true)));
  if (words.length % 2) words.push(0n);
  return words;
}

function cs64(data: Uint8Array, digest: Uint8Array): [bigint, bigint] {
  const dv = new DataView(digest.buffer, digest.byteOffset);
  const keyA = BigInt(dv.getUint32(0, true)) | 1n;
  const keyB = BigInt(dv.getUint32(4, true)) | 1n;
  const factors = [(keyA * CS64_FACTOR) & M, (keyB * CS64_FACTOR) & M];
  const terms = CS64.map(([coef], i) => (coef * factors[i % 2]) & M);
  const offsets = CS64.map(([, off]) => off);
  const prefixed = new Uint8Array(data.length + 1);
  prefixed.set(data, 1);
  wordsLe4Even(prefixed).forEach((word, i) => {
    let term = word * (i % 2 === 0 ? keyA : keyB);
    let offset = rol16(word) * (i % 2 === 0 ? 0xef0569fbn : 0xc31713dbn);
    if (i === 0) { term += CS64_ADJUSTMENT0 * factors[0]; offset += CS64_ADJUSTMENT1; }
    terms.push(term & M);
    offsets.push(offset & M);
  });
  let swapAcc = 0n, swapLast = 0n, state = 0n, acc = 0n;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i], y = terms[i + 1];
    let t = rol16((offsets[i] + x) & M);
    let q = (t * 0x76f50f34n) & M;
    swapAcc += (rol16(q) * 0xc3efea97n + q) & M;
    t = rol16((offsets[i + 1] + y) & M);
    q = (t * 0x1881ce3cn) & M;
    swapLast = (rol16(q) * 0x35bd1ec9n + q) & M;
    swapAcc = (swapAcc + swapLast) & M;
    state = (state * keyA + x) & M;
    state = (rol16(state) * 0xcf98b111n) & M;
    state = (rol16(state) * 0x87085b9fn) & M;
    state = (rol16(state) * 0x12ceb96dn) & M;
    state = (rol16(state) * 0x257e1d83n) & M;
    acc += state;
    t = (state * keyB + y) & M;
    t = (rol16(t) * 0xa27416f5n) & M;
    t = (rol16(t) * 0xd38396ffn) & M;
    state = (rol16((rol16(t) * 0x7c932b89n) & M) * 0xbfa49f69n) & M;
    acc = (acc + state) & M;
  }
  return [swapLast ^ state, swapAcc ^ acc];
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();

/** '<16 hex>-<64 hex>' cho khung năm phút chứa unixSeconds. */
export function secMsGecV2(unixSeconds: number): string {
  let ticks = unixSeconds + WIN_EPOCH;
  ticks -= ticks % 300;
  // Python in giá trị đúng của số double ('%.0f'); BigInt của cùng số double in ra đúng các chữ số đó.
  const data = new TextEncoder().encode(`${BigInt(ticks * 1e7)}${TRUSTED_CLIENT_TOKEN}`);
  const digest = sha256(data);
  const [lo, hi] = cs64(data, digest);
  const packed = new Uint8Array(8);
  new DataView(packed.buffer).setUint32(0, Number(lo), true);
  new DataView(packed.buffer).setUint32(4, Number(hi), true);
  return `${hex(packed)}-${hex(digest)}`;
}

/** Endpoint edge-tts 7.3.1 dùng; api.msedgeservices.com của msedge-tts từ chối token v2. */
export const EDGE_WSS = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';

interface EdgeTtsClass { _clockOffsetMs?: number; generateUUID(): string; getSynthUrl(): Promise<string> }

/** Cho msedge-tts kết nối như edge-tts 7.3.1, với token v2; gọi một lần trước khi đọc. */
export function useV2Token(cls: unknown): void {
  const c = cls as EdgeTtsClass;
  c.getSynthUrl = async function getSynthUrl() {
    const token = secMsGecV2((Date.now() + (c._clockOffsetMs ?? 0)) / 1000);
    return `${EDGE_WSS}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&ConnectionId=${c.generateUUID().replace(/-/g, '')}&Sec-MS-GEC=${token}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;
  };
}
