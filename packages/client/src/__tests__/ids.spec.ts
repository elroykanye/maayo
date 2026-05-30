import { describe, it, expect } from 'vitest';
import { ulid } from '../ids';

describe('ulid', () => {
  it('generates a 26-character string', () => {
    expect(ulid()).toHaveLength(26);
  });

  it('generates unique values', () => {
    const ids = Array.from({ length: 100 }, () => ulid());
    const unique = new Set(ids);
    expect(unique.size).toBe(100);
  });

  it('generates lexicographically sortable ids when called in sequence', () => {
    const a = ulid();
    const b = ulid();
    // Same-millisecond ids may be equal or ordered by random; different-ms must be ordered.
    expect(a <= b).toBe(true);
  });

  it('uses only Crockford base-32 characters', () => {
    const CROCKFORD = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;
    for (let i = 0; i < 20; i++) {
      expect(ulid()).toMatch(CROCKFORD);
    }
  });
});
