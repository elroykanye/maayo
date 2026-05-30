/**
 * Builds a channel string from a scope descriptor.
 *
 * @example
 * channelFor({ org: 'abc123', school: 'xyz456' })
 * // → 'org:abc123/school:xyz456'
 */
export function channelFor(scope: Record<string, string>): string {
  return Object.entries(scope)
    .map(([key, value]) => `${key}:${value}`)
    .join('/');
}

/**
 * Derives a deduplicated channel list from an array of grant objects.
 *
 * @example
 * channelsFromGrants(grants, (g) => ({ org: g.orgId, school: g.schoolId }))
 */
export function channelsFromGrants<G>(
  grants: G[],
  toScope: (grant: G) => Record<string, string>,
): string[] {
  return [...new Set(grants.map((g) => channelFor(toScope(g))))];
}
