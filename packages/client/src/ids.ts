const DEVICE_ID_KEY = 'maayo:deviceId';

/** Generates a ULID without external dependencies. */
export function ulid(): string {
  const now = Date.now();
  const timeChars = encodeTime(now, 10);
  const randChars = encodeRandom(16);
  return timeChars + randChars;
}

/** Returns a stable per-browser device UUID, persisted in localStorage. */
export function deviceId(): string {
  try {
    const stored = localStorage.getItem(DEVICE_ID_KEY);
    if (stored) return stored;
    const id = generateUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
    return id;
  } catch {
    return generateUUID();
  }
}

// --- ULID internals ---

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = ENCODING.length;
const TIME_MAX = Math.pow(2, 48) - 1;

function encodeTime(ms: number, len: number): string {
  if (ms > TIME_MAX) throw new RangeError('Time value exceeds maximum for ULID');
  let t = ms;
  let str = '';
  for (let i = len - 1; i >= 0; i--) {
    str = ENCODING[t % ENCODING_LEN] + str;
    t = Math.floor(t / ENCODING_LEN);
  }
  return str;
}

function encodeRandom(len: number): string {
  let str = '';
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < len; i++) {
    str += ENCODING[bytes[i] % ENCODING_LEN];
  }
  return str;
}

function generateUUID(): string {
  return crypto.randomUUID();
}
