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
  /** Causal dependencies — reserved for future ordering guarantees */
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
