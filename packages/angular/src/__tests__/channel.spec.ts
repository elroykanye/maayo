import { describe, it, expect } from 'vitest';
import { channelFor, channelsFromGrants } from '../channel';

describe('channelFor', () => {
  it('joins segments with / and separates key:value with :', () => {
    expect(channelFor({ org: 'abc', school: 'xyz' })).toBe('org:abc/school:xyz');
  });

  it('handles a single-segment scope', () => {
    expect(channelFor({ org: 'root' })).toBe('org:root');
  });

  it('preserves insertion order', () => {
    expect(channelFor({ org: '1', school: '2', term: '3' })).toBe('org:1/school:2/term:3');
  });
});

describe('channelsFromGrants', () => {
  interface Grant { orgId: string; schoolId: string }

  const grants: Grant[] = [
    { orgId: 'o1', schoolId: 's1' },
    { orgId: 'o1', schoolId: 's2' },
    { orgId: 'o1', schoolId: 's1' }, // duplicate — should be de-duped
  ];

  it('maps grants to channel strings', () => {
    const channels = channelsFromGrants(grants, (g) => ({ org: g.orgId, school: g.schoolId }));
    expect(channels).toContain('org:o1/school:s1');
    expect(channels).toContain('org:o1/school:s2');
  });

  it('de-duplicates channels', () => {
    const channels = channelsFromGrants(grants, (g) => ({ org: g.orgId, school: g.schoolId }));
    expect(channels).toHaveLength(2);
  });

  it('returns empty array for empty grants', () => {
    expect(channelsFromGrants([], (g: Grant) => ({ org: g.orgId }))).toEqual([]);
  });
});
