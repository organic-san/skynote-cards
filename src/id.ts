import fs from 'node:fs';

/**
 * 卡片 ID：64-bit 整數，以十進位字串表示。
 *
 *   id = ((now - 2026-01-01T00:00:00Z) << 22) | (random 12 bits << 10) | seq(10 bits)
 *
 * 同一毫秒內 seq 從 0 遞增，所以先建立的卡片一定有較小的 ID。
 * 連結規則用 ID 大小定義「較早」，這個順序不能是隨機的。
 * ID 內不編碼類型、主題或層級，且不重用、不重編號。
 */

export const EPOCH = 1767225600000n; // 2026-01-01T00:00:00Z

const SEQ_BITS = 10n;
const SEQ_MAX = (1 << Number(SEQ_BITS)) - 1; // 1023
const RAND_BITS = 12n;

let lastMs = -1n;
let seq = 0;
let rand = 0n;

function randomBits(bits: bigint): bigint {
  const max = 1 << Number(bits);
  return BigInt(Math.floor(Math.random() * max));
}

function nextRaw(): bigint {
  let ms = BigInt(Date.now()) - EPOCH;
  if (ms === lastMs) {
    if (seq >= SEQ_MAX) {
      // 同一毫秒用完 1024 個序號：等到下一毫秒。單人工具幾乎不會走到。
      while (BigInt(Date.now()) - EPOCH === lastMs) {
        /* spin */
      }
      ms = BigInt(Date.now()) - EPOCH;
    } else {
      seq += 1;
      return (ms << 22n) | (rand << SEQ_BITS) | BigInt(seq);
    }
  }
  if (ms < lastMs) {
    // 時鐘倒退：不允許發出比已發出的更小的 ID，沿用上一個毫秒繼續遞增。
    ms = lastMs;
    if (seq < SEQ_MAX) {
      seq += 1;
      return (ms << 22n) | (rand << SEQ_BITS) | BigInt(seq);
    }
  }
  lastMs = ms;
  seq = 0;
  rand = randomBits(RAND_BITS);
  return (ms << 22n) | (rand << SEQ_BITS);
}

/**
 * 產生一個尚未被使用的 ID。
 * `taken` 是最後一道防線（例如多個行程同時寫入同一個語料庫）。
 */
export function generateId(taken?: (id: string) => boolean): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = nextRaw().toString();
    if (!taken || !taken(id)) return id;
  }
  throw new Error('generateId: 連續 100 次都碰撞，拒絕繼續');
}

export function fileExistsTaken(dir: string): (id: string) => boolean {
  return (id) => fs.existsSync(`${dir}/${id}.md`);
}

/** ID 一律轉 BigInt 比較：位數會隨時間增加，字串比較不可靠。 */
export function compareIds(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

const ID_RE = /^[0-9]{1,20}$/;

export function isValidIdFormat(v: unknown): v is string {
  return typeof v === 'string' && ID_RE.test(v);
}
