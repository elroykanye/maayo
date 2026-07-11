/**
 * OPTIONAL third endpoint: `GET /sync/schema` — the server's declared conflict
 * policy per entity type. Lets a policy-aware client (see `@maayo/client`'s
 * `policyApply`) branch on the SAME policy the server's appliers enforce, so
 * both sides run one merge function over the mutation log instead of drifting.
 * A server that doesn't implement it simply has clients fall back to plain
 * last-writer-wins.
 */

/**
 * Conflict policy for one entity type.
 *
 * - `LWW`         whole-row last-writer-wins; deterministic
 *                 `(clientTs, deviceId, id)` tie-break; deletes are gated
 *                 tombstones.
 * - `FIELD_LWW`   per-field last-writer-wins: concurrent edits to DIFFERENT
 *                 fields both survive; existence is one more field.
 * - `APPEND_ONLY` immutable ledger: first CREATE wins forever; UPDATE/PATCH/
 *                 DELETE are ignored (corrections are new rows).
 * - `OR_SET`      add-wins observed-remove set: every CREATE is an add-tag,
 *                 a DELETE removes only the tags named in its `parentIds`,
 *                 so an unobserved concurrent re-add survives a remove.
 * - `MANUAL`      last-writer-wins for the current value, but a concurrent
 *                 differing write flags a conflict for a human to resolve —
 *                 never a silent pick.
 */
export type SyncPolicy = 'LWW' | 'FIELD_LWW' | 'APPEND_ONLY' | 'OR_SET' | 'MANUAL';

export interface EntitySchema {
  /** PascalCase entity type, matching `Mutation.entityType`. */
  entityType: string;
  policy: SyncPolicy;
}

/** Response body of `GET /sync/schema`. */
export interface SchemaResponse {
  entities: EntitySchema[];
}

/**
 * Author id for SERVER-AUTHORED mutations — rows the backend appends to its
 * own change log (materialised-state fan-out such as conflict notifications).
 * Policy-aware clients apply these verbatim, outside normal per-policy gating,
 * and must never originate them. Servers should reject pushed mutations
 * claiming this author.
 */
export const SYSTEM_AUTHOR = 'system';
