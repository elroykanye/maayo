import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderHook } from '@testing-library/react';
import type { SyncEngine, SyncStatus } from '@maayo/client';
import { channelFor, channelsFromGrants } from '@maayo/client';
import { SyncContext } from '../provider';
import { useSyncStatus, useCollection } from '../hooks';
import { useSyncEngine } from '../provider';

function makeMockEngine(status: SyncStatus = 'idle'): SyncEngine {
  return {
    db: { table: () => ({ toArray: () => Promise.resolve([]) }) } as unknown as SyncEngine['db'],
    status,
    start: vi.fn(),
    stop: vi.fn(),
    onStatusChange: vi.fn(() => () => {}),
  } as unknown as SyncEngine;
}

function withEngine(engine: SyncEngine) {
  return ({ children }: { children: React.ReactNode }) => (
    <SyncContext.Provider value={engine}>{children}</SyncContext.Provider>
  );
}

// --- channel utils ---

describe('channelFor', () => {
  it('joins segments as key:value/key:value', () => {
    expect(channelFor({ org: 'abc', school: 'xyz' })).toBe('org:abc/school:xyz');
  });

  it('handles a single segment', () => {
    expect(channelFor({ org: 'root' })).toBe('org:root');
  });
});

describe('channelsFromGrants', () => {
  interface Grant { orgId: string; schoolId: string }
  const grants: Grant[] = [
    { orgId: 'o1', schoolId: 's1' },
    { orgId: 'o1', schoolId: 's2' },
    { orgId: 'o1', schoolId: 's1' }, // duplicate
  ];

  it('maps grants to channel strings', () => {
    const ch = channelsFromGrants(grants, (g) => ({ org: g.orgId, school: g.schoolId }));
    expect(ch).toContain('org:o1/school:s1');
    expect(ch).toContain('org:o1/school:s2');
  });

  it('de-duplicates channels', () => {
    const ch = channelsFromGrants(grants, (g) => ({ org: g.orgId, school: g.schoolId }));
    expect(ch).toHaveLength(2);
  });
});

// --- hooks ---

describe('useSyncEngine', () => {
  it('throws outside SyncProvider', () => {
    expect(() => renderHook(() => useSyncEngine())).toThrow(
      'useSyncEngine must be used within <SyncProvider>',
    );
  });

  it('returns the engine inside SyncProvider', () => {
    const engine = makeMockEngine();
    const { result } = renderHook(() => useSyncEngine(), { wrapper: withEngine(engine) });
    expect(result.current).toBe(engine);
  });
});

describe('useSyncStatus', () => {
  it('returns the initial engine status', () => {
    const engine = makeMockEngine('idle');
    const { result } = renderHook(() => useSyncStatus(), { wrapper: withEngine(engine) });
    expect(result.current).toBe('idle');
  });
});

describe('useCollection', () => {
  it('returns an empty array initially', () => {
    const engine = makeMockEngine();
    const { result } = renderHook(() => useCollection('student'), { wrapper: withEngine(engine) });
    expect(result.current).toEqual([]);
  });
});
