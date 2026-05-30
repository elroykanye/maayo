const DEVICE_ID_KEY = 'maayo:deviceId';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_MAX = Math.pow(2, 48) - 1;

// Monotonic state: last timestamp + last 10-byte random block
let _lastMs = -1;
let _lastRand = new Uint8Array(10);

/**
 * Generates a monotonic ULID (48-bit time + 80-bit random, Crockford base-32).
 * Same-millisecond calls increment the random component so the sequence is
 * strictly ascending.
 */
export function ulid(): string {
  const now = Date.now();
  if (now === _lastMs) {
    incrementBytes(_lastRand);
  } else {
    _lastMs = now;
    crypto.getRandomValues(_lastRand);
  }
  return encodeTime(now) + encodeBytes80(_lastRand);
}

/** Returns a stable per-browser device UUID, persisted in localStorage. */
export function deviceId(): string {
  try {
    const stored = localStorage.getItem(DEVICE_ID_KEY);
    if (stored) return stored;
    const id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

// --- internals ---

function encodeTime(ms: number): string {
  if (ms > TIME_MAX) throw new RangeError('Timestamp exceeds ULID maximum');
  const chars = new Array<string>(10);
  let t = ms;
  for (let i = 9; i >= 0; i--) {
    chars[i] = ENCODING[t & 0x1f];
    t = Math.floor(t / 32);
  }
  return chars.join('');
}

/** Encodes 10 bytes (80 bits) as 16 Crockford base-32 chars, 5 bits per char. */
function encodeBytes80(src: Uint8Array): string {
  const chars = new Array<string>(16);
  let bitPos = 0;
  for (let k = 0; k < 16; k++) {
    let val = 0;
    for (let b = 0; b < 5; b++) {
      const byteIdx = Math.floor(bitPos / 8);
      const bitIdx = 7 - (bitPos % 8);
      val = (val << 1) | ((src[byteIdx] >> bitIdx) & 1);
      bitPos++;
    }
    chars[k] = ENCODING[val];
  }
  return chars.join('');
}

/** Increments src as a big-endian integer in-place. Wraps silently on overflow. */
function incrementBytes(src: Uint8Array): void {
  for (let i = src.length - 1; i >= 0; i--) {
    if (src[i] < 255) { src[i]++; return; }
    src[i] = 0;
  }
}
