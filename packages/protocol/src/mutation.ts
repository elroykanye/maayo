export type MutationOp = 'CREATE' | 'UPDATE' | 'DELETE' | 'PATCH';

export interface Mutation {
  /** ULID — idempotent mutation identifier, 26 chars, sortable by time */
  id: string;
  /** Target channel, e.g. "org:abc/school:xyz" */
  channel: string;
  /** PascalCase entity type, e.g. "Student" */
  entityType: string;
  /** UUID of the affected record */
  entityId: string;
  op: MutationOp;
  /** JSON-serialised entity snapshot */
  payload: string;
  authorIdentityId: string;
  /** Stable per-browser UUID */
  deviceId: string;
  /** ISO-8601 client-side timestamp */
  clientTs: string;
  /**
   * Causal dependencies: ids of the mutations this write OBSERVED before it
   * was made. `[]` means "no ancestry claimed" (legacy clients; still valid).
   * Conventions used by policy-aware merges:
   *  - upserts cite the entity's current head mutation id (the last write the
   *    device had applied for this entity);
   *  - OR_SET DELETEs cite the observed ADD-TAG ids — the remove kills exactly
   *    those adds, so a concurrent unobserved re-add survives (add-wins);
   *  - MANUAL conflict detection treats a write whose parents don't include
   *    the current winner as CONCURRENT with it.
   * Servers must persist and echo this field verbatim in /sync/changes.
   */
  parentIds: string[];
}

export interface BatchMutationsRequest {
  mutations: Mutation[];
}

export interface AcceptedMutation {
  id: string;
  receivedAt: string;
}

export interface RejectedMutation {
  id: string;
  /** Human-readable explanation, safe to surface in a client UI. */
  reason: string;
  /**
   * Optional machine-readable rejection code (e.g. "SLUG_TAKEN", "FORBIDDEN").
   * Clients use it to tell PERMANENT rejections (quarantine immediately, don't
   * burn the retry budget) from transient ones worth re-pushing.
   */
  code?: string;
}

export interface BatchMutationsResponse {
  accepted: AcceptedMutation[];
  rejected: RejectedMutation[];
}
