import type { Mutation } from './mutation';

export interface Cursor {
  /** ULID of the last mutation seen, null on first pull */
  lastMutationId: string | null;
  /** ISO-8601 server timestamp of the last mutation seen */
  lastReceivedAt: string | null;
}

export interface ChangesResponse {
  channel: string;
  mutations: Mutation[];
  cursor: Cursor;
  /** True when there are more pages available; client should re-pull immediately */
  hasMore: boolean;
}

/** Query params for GET /sync/changes */
export interface ChangesQuery {
  channel: string;
  /** ISO-8601 — pull only mutations received after this timestamp */
  since?: string;
  /** Max mutations per response, default 500 */
  limit?: number;
}
