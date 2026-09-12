import { describe, expect, it } from 'vitest';
import {
  CHECKPOINT_PROTOCOL_VERSION,
  CHECKPOINT_REQUIRED,
  isCheckpointEnvelope,
  isCheckpointRequiredResponse,
  type CheckpointEnvelope,
} from './index';

const validCheckpoint = (): CheckpointEnvelope => ({
  protocolVersion: CHECKPOINT_PROTOCOL_VERSION,
  schemaVersion: '2026-09-12',
  channel: 'org:abc',
  projectionKey: 'member:42',
  projectionRevision: 'grants:7',
  throughCursor: {
    lastMutationId: '01ABCDEFGHJKMNPQRSTVWXYZ01',
    lastReceivedAt: '2026-09-12T12:00:00.000Z',
  },
  rows: [{
    entityType: 'Student',
    entityId: 'student-1',
    payload: { id: 'student-1', name: 'Ada' },
  }],
  mergeMetadata: [{
    entityType: 'Student',
    entityId: 'student-1',
    value: { key: 'Student:student-1', head: '01ABCDEFGHJKMNPQRSTVWXYZ01' },
  }],
  integrity: {
    algorithm: 'sha-256',
    checksum: '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU',
    scope: 'rows-and-merge-metadata',
  },
});

describe('checkpoint protocol guards', () => {
  it('accepts a complete checkpoint envelope with structured rows and merge metadata', () => {
    expect(isCheckpointEnvelope(validCheckpoint())).toBe(true);
  });

  it.each([
    ['protocol version', { protocolVersion: 999 }],
    ['projection key', { projectionKey: '' }],
    ['projection revision', { projectionRevision: '' }],
    ['compound cursor', { throughCursor: { lastMutationId: 'id-only', lastReceivedAt: null } }],
    ['structured row payload', { rows: [{ entityType: 'Student', entityId: 's1', payload: '{"id":"s1"}' }] }],
    ['checksum', { integrity: { algorithm: 'sha-256', checksum: 'not a digest!', scope: 'rows-and-merge-metadata' } }],
  ])('rejects an invalid %s', (_label, override) => {
    expect(isCheckpointEnvelope({ ...validCheckpoint(), ...override })).toBe(false);
  });

  it('recognizes only the stable stale-cursor signal', () => {
    expect(isCheckpointRequiredResponse({ code: CHECKPOINT_REQUIRED, channel: 'org:abc' })).toBe(true);
    expect(isCheckpointRequiredResponse({ code: 'CHECKPOINT_REQUIRED' })).toBe(false);
    expect(isCheckpointRequiredResponse({ code: 'OTHER', channel: 'org:abc' })).toBe(false);
  });
});
