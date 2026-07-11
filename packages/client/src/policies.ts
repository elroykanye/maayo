/**
 * Policy-aware merge — an opt-in replacement for the built-in last-writer-wins
 * apply, driven by the server's declared conflict policy per entity type
 * (see `@maayo/protocol`'s `SyncPolicy` / `GET /sync/schema`).
 *
 * Wire it with one line:
 *
 * ```ts
 * new SyncEngine({
 *   ...,
 *   tables: { ...yourTables, _syncmeta: 'key' },   // REQUIRED bookkeeping table
 *   applyMutation: policyApply({ policyFor: (t) => policies[t] ?? 'LWW' }),
 * });
 * ```
 *
 * Each policy's fold is a join-semilattice — max-tuple high-water marks,
 * min-tuple (APPEND_ONLY), and grow-only sets/maps — so the materialised row is
 * a function of the mutation SET, not the arrival order: replicas that receive
 * the same mutations in any order converge to byte-identical state. That
 * property is testable with the harness in `testing.ts`.
 *
 * Semantics per policy:
 *  - LWW         whole-row put; winner = max tuple `(clientTs, deviceId, id)`;
 *                DELETE is a gated SOFT tombstone (`{ id, deletedAt }`).
 *  - FIELD_LWW   per-field max tuple: concurrent edits to different fields both
 *                survive; existence (`__deleted`) is one more field. Pair with
 *                changed-fields-only PATCH payloads for full effect.
 *  - APPEND_ONLY create-only, immutable; earliest CREATE wins; UPDATE/PATCH/
 *                DELETE never touch the row.
 *  - OR_SET      add-wins observed-remove: CREATEs are add-tags, a DELETE
 *                tombstones only the tags named in its `parentIds` (legacy
 *                parent-less deletes fall back to a tuple gate); the element is
 *                present iff one tag is alive.
 *  - MANUAL      gated LWW for the value + `hasConflict`/`conflictPayload` when
 *                a concurrent (non-causally-ordered) differing write exists —
 *                never a silent pick. Server-authored (`SYSTEM_AUTHOR`) PATCHes
 *                are applied verbatim (conflict fan-out).
 *
 * Bookkeeping lives in a consumer-declared meta table (default `_syncmeta`,
 * schema `'key'`), one row per `${entityType}:${entityId}` — NOT on entity
 * rows, so spreading a row into a payload can never leak merge metadata.
 */
import type { Mutation, SyncPolicy } from '@maayo/protocol';
import type { MaayoDatabase } from './database';
import type { ApplyMutationHook, ApplyOutcome } from './pull';

// --- persisted bookkeeping ----------------------------------------------------

/** A stored total-order tuple. Three fields (never a joined string) so
 * comparison is componentwise — a joined string mis-sorts when one deviceId is
 * a prefix of another. */
export interface StoredTuple {
  t: string; // clientTs (ISO-8601)
  d: string; // deviceId
  m: string; // mutation id (ULID)
}

interface ManualUpsert {
  t: string;
  d: string;
  /** parentIds of the original mutation (causal ancestry). */
  p: string[];
  payload: Record<string, unknown>;
}

interface OrSetAdd {
  t: string;
  d: string;
  payload: Record<string, unknown>;
}

/** The meta-table row for one entity. `key` = `${entityType}:${entityId}`. */
export interface PolicyMeta {
  key: string;
  /** Policy-specific winner tuple (LWW/FIELD_LWW/MANUAL: max seen;
   *  APPEND_ONLY: the winning earliest CREATE). */
  t: string;
  d: string;
  m: string;
  /** Mutation id local writes should cite as their causal parent. */
  head: string;
  /** FIELD_LWW: per-field winning tuple; `__deleted` is the existence field. */
  fieldTs?: Record<string, StoredTuple>;
  /** OR_SET bookkeeping. */
  orset?: {
    adds: Record<string, OrSetAdd>;
    removed: string[];
    patch?: StoredTuple & { payload: Record<string, unknown> };
    del?: StoredTuple;
  };
  /** MANUAL bookkeeping: upsert summaries by mutation id + max delete. */
  manual?: {
    ups: Record<string, ManualUpsert>;
    del?: StoredTuple;
  };
}

/** What the caller must do with the entity row. Meta is ALWAYS persisted. */
export interface PolicyDecision {
  action: 'put' | 'skip';
  /** Full row to put (always includes `id`; tombstones carry `deletedAt`). */
  row?: Record<string, unknown>;
  meta: PolicyMeta;
}

/** Default author id of server-authored fan-out mutations — mirrors
 * `@maayo/protocol`'s `SYSTEM_AUTHOR` (kept local so this package stays
 * type-only on the protocol; see PolicyApplyOptions.systemAuthorId). */
const SYSTEM_AUTHOR = 'system';

const DELETED_FIELD = '__deleted';

/** Cap on MANUAL upsert summaries so a hot row can't grow its meta forever;
 *  eviction drops the lowest tuples (already-superseded candidates). */
const MANUAL_UPS_CAP = 50;

type Tuple = readonly [string, string, string];

function cmpTuple(a: Tuple, b: Tuple): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  if (a[2] !== b[2]) return a[2] < b[2] ? -1 : 1;
  return 0;
}

function tupleOf(m: Mutation): Tuple {
  return [m.clientTs, m.deviceId, m.id];
}

function storedTuple(m: Mutation): StoredTuple {
  return { t: m.clientTs, d: m.deviceId, m: m.id };
}

function asTuple(s: StoredTuple): Tuple {
  return [s.t, s.d, s.m];
}

function keyOf(entityType: string, entityId: string): string {
  return `${entityType}:${entityId}`;
}

/** Bootstrap tuple for a row that predates the meta table: `updatedAt`
 * approximates the writer's clock; empty deviceId/id means any REAL tuple at
 * the same timestamp wins the tie — deterministically on every replica. */
function legacyTuple(row: Record<string, unknown> | undefined): StoredTuple {
  return { t: String(row?.['updatedAt'] ?? ''), d: '', m: '' };
}

function newMeta(m: Mutation): PolicyMeta {
  const t = storedTuple(m);
  return { key: keyOf(m.entityType, m.entityId), ...t, head: t.m };
}

function raise(meta: PolicyMeta, m: Mutation): boolean {
  if (cmpTuple(tupleOf(m), asTuple(meta)) <= 0) return false;
  meta.t = m.clientTs;
  meta.d = m.deviceId;
  meta.m = m.id;
  meta.head = m.id;
  return true;
}

/**
 * Fold ONE mutation into the current (row, meta) for its entity under
 * `policy`. Pure — the caller persists `meta` unconditionally and puts `row`
 * when `action === 'put'`. `payload` is the mutation's payload, parsed.
 */
export function applyPolicyMutation(
  row: Record<string, unknown> | undefined,
  meta: PolicyMeta | undefined,
  m: Mutation,
  payload: Record<string, unknown>,
  policy: SyncPolicy,
): PolicyDecision {
  switch (policy) {
    case 'APPEND_ONLY':
      return applyAppendOnly(row, meta, m, payload);
    case 'FIELD_LWW':
      return applyFieldLww(row, meta, m, payload);
    case 'OR_SET':
      return applyOrSet(meta, m, payload);
    case 'MANUAL':
      return applyManual(meta, m, payload);
    case 'LWW':
    default:
      return applyLww(row, meta, m, payload);
  }
}

// --- LWW ------------------------------------------------------------------------

function applyLww(
  row: Record<string, unknown> | undefined,
  meta: PolicyMeta | undefined,
  m: Mutation,
  payload: Record<string, unknown>,
): PolicyDecision {
  const current = meta ?? (row ? { ...newMeta(m), ...legacyTuple(row), head: '' } : undefined);
  if (!current) {
    const fresh = newMeta(m);
    return m.op === 'DELETE'
      ? { action: 'put', row: { id: m.entityId, deletedAt: m.clientTs }, meta: fresh }
      : // `deletedAt: null` MUST be set here too — the later-winner branch below
        // writes it, so omitting it on first arrival would make the final row
        // depend on arrival order (caught by the convergence harness).
        { action: 'put', row: { ...payload, id: m.entityId, deletedAt: null }, meta: fresh };
  }
  if (!raise(current, m)) return { action: 'skip', meta: current };
  if (m.op === 'DELETE') {
    // Deterministic tombstone: only { id, deletedAt } — carrying whatever
    // fields the row had at delete time would depend on arrival order.
    return { action: 'put', row: { id: m.entityId, deletedAt: m.clientTs }, meta: current };
  }
  return { action: 'put', row: { ...payload, id: m.entityId, deletedAt: null }, meta: current };
}

// --- APPEND_ONLY -------------------------------------------------------------------

/** "No CREATE seen yet" sentinel — sorts after every real timestamp, so the
 * first CREATE always replaces it. (Seeding from an UPDATE's tuple would
 * wrongly block a CREATE with a later timestamp.) */
const NO_CREATE_TUPLE: StoredTuple = { t: String.fromCharCode(0xffff), d: '', m: '' };

function applyAppendOnly(
  row: Record<string, unknown> | undefined,
  meta: PolicyMeta | undefined,
  m: Mutation,
  payload: Record<string, unknown>,
): PolicyDecision {
  const current: PolicyMeta = meta ?? {
    key: keyOf(m.entityType, m.entityId),
    ...(row ? { t: String(row['createdAt'] ?? row['updatedAt'] ?? ''), d: '', m: '' } : NO_CREATE_TUPLE),
    head: '',
  };
  if (m.op !== 'CREATE') {
    return { action: 'skip', meta: current }; // immutable ledger
  }
  if (cmpTuple(tupleOf(m), asTuple(current)) < 0) {
    const next = { ...current, ...storedTuple(m), head: m.id };
    return { action: 'put', row: { ...payload, id: m.entityId }, meta: next };
  }
  return { action: 'skip', meta: current };
}

// --- FIELD_LWW ---------------------------------------------------------------------

function applyFieldLww(
  row: Record<string, unknown> | undefined,
  meta: PolicyMeta | undefined,
  m: Mutation,
  payload: Record<string, unknown>,
): PolicyDecision {
  const current: PolicyMeta = meta ?? {
    ...(row ? { ...newMeta(m), ...legacyTuple(row), head: '' } : newMeta(m)),
    fieldTs: row
      ? Object.fromEntries(
          Object.keys(row)
            .filter((f) => f !== 'id')
            .concat([DELETED_FIELD])
            .map((f): [string, StoredTuple] => [f, legacyTuple(row)]),
        )
      : {},
  };
  const fieldTs = (current.fieldTs ??= {});
  const next: Record<string, unknown> = { ...(row ?? {}), id: m.entityId };
  let changed = false;

  const consider = (field: string, write: () => void): void => {
    const stored = fieldTs[field];
    if (stored && cmpTuple(tupleOf(m), asTuple(stored)) <= 0) return;
    fieldTs[field] = storedTuple(m);
    write();
    changed = true;
  };

  if (m.op === 'DELETE') {
    consider(DELETED_FIELD, () => {
      next['deletedAt'] = m.clientTs;
    });
  } else {
    consider(DELETED_FIELD, () => {
      next['deletedAt'] = null;
    });
    for (const [field, value] of Object.entries(payload)) {
      if (field === 'id') continue;
      consider(field, () => {
        next[field] = value;
      });
    }
  }
  raise(current, m);
  if (!changed) return { action: 'skip', meta: current };
  return { action: 'put', row: next, meta: current };
}

// --- OR_SET ---------------------------------------------------------------------------

function applyOrSet(meta: PolicyMeta | undefined, m: Mutation, payload: Record<string, unknown>): PolicyDecision {
  const current: PolicyMeta = meta ?? { ...newMeta(m), orset: { adds: {}, removed: [] } };
  const os = (current.orset ??= { adds: {}, removed: [] });

  if (m.op === 'CREATE') {
    os.adds[m.id] = { t: m.clientTs, d: m.deviceId, payload: { ...payload } };
  } else if (m.op === 'DELETE') {
    for (const tag of m.parentIds ?? []) {
      if (!os.removed.includes(tag)) os.removed.push(tag);
    }
    if (!os.del || cmpTuple(tupleOf(m), asTuple(os.del)) > 0) os.del = storedTuple(m);
  } else {
    if (!os.patch || cmpTuple(tupleOf(m), asTuple(os.patch)) > 0) {
      os.patch = { ...storedTuple(m), payload: { ...payload } };
    }
  }
  raise(current, m);
  return { action: 'put', row: materialiseOrSet(m.entityId, os), meta: current };
}

function materialiseOrSet(entityId: string, os: NonNullable<PolicyMeta['orset']>): Record<string, unknown> {
  // A delete that named NO tags came from a legacy client — it gates like LWW:
  // kills exactly the adds strictly below its tuple, order-independently.
  const legacyDel = os.del && os.removed.length === 0 ? os.del : undefined;
  const live = Object.entries(os.adds).filter(([tagId, add]) => {
    if (os.removed.includes(tagId)) return false;
    if (legacyDel && cmpTuple([add.t, add.d, tagId], asTuple(legacyDel)) < 0) return false;
    return true;
  });
  if (live.length === 0) {
    return { id: entityId, deletedAt: os.del ? os.del.t : null };
  }
  let base = live[0];
  for (const entry of live) {
    if (cmpTuple([entry[1].t, entry[1].d, entry[0]], [base[1].t, base[1].d, base[0]]) > 0) base = entry;
  }
  const row: Record<string, unknown> = { ...base[1].payload, id: entityId, deletedAt: null };
  if (os.patch && cmpTuple(asTuple(os.patch), [base[1].t, base[1].d, base[0]]) > 0) {
    Object.assign(row, os.patch.payload, { id: entityId, deletedAt: null });
  }
  return row;
}

// --- MANUAL --------------------------------------------------------------------------

function applyManual(meta: PolicyMeta | undefined, m: Mutation, payload: Record<string, unknown>): PolicyDecision {
  const current: PolicyMeta = meta ?? { ...newMeta(m), manual: { ups: {} } };
  const man = (current.manual ??= { ups: {} });

  if (m.op === 'DELETE') {
    if (!man.del || cmpTuple(tupleOf(m), asTuple(man.del)) > 0) man.del = storedTuple(m);
  } else {
    man.ups[m.id] = { t: m.clientTs, d: m.deviceId, p: [...(m.parentIds ?? [])], payload: { ...payload } };
    pruneManual(man);
  }
  raise(current, m);
  return { action: 'put', row: materialiseManual(m.entityId, man), meta: current };
}

function pruneManual(man: NonNullable<PolicyMeta['manual']>): void {
  const ids = Object.keys(man.ups);
  if (ids.length <= MANUAL_UPS_CAP) return;
  ids
    .sort((a, b) => cmpTuple([man.ups[a].t, man.ups[a].d, a], [man.ups[b].t, man.ups[b].d, b]))
    .slice(0, ids.length - MANUAL_UPS_CAP)
    .forEach((id) => delete man.ups[id]);
}

function materialiseManual(entityId: string, man: NonNullable<PolicyMeta['manual']>): Record<string, unknown> {
  const ups = Object.entries(man.ups);

  // Existence: the tombstone wins only if its tuple beats every upsert.
  let maxUp: [string, ManualUpsert] | null = null;
  for (const entry of ups) {
    if (!maxUp || cmpTuple([entry[1].t, entry[1].d, entry[0]], [maxUp[1].t, maxUp[1].d, maxUp[0]]) > 0) maxUp = entry;
  }
  if (!maxUp) {
    return { id: entityId, deletedAt: man.del ? man.del.t : null };
  }
  if (man.del && cmpTuple(asTuple(man.del), [maxUp[1].t, maxUp[1].d, maxUp[0]]) > 0) {
    return { id: entityId, deletedAt: man.del.t };
  }

  // Conflict: another upsert with a differing value that the winner did not
  // causally observe (transitive parentIds walk over the recorded summaries).
  const ancestors = new Set<string>();
  const stack = [...maxUp[1].p];
  while (stack.length) {
    const id = stack.pop() as string;
    if (ancestors.has(id)) continue;
    ancestors.add(id);
    const parent = man.ups[id];
    if (parent) stack.push(...parent.p);
  }
  const signature = (payload: Record<string, unknown>): string =>
    JSON.stringify(Object.entries(payload).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const winnerSig = signature(maxUp[1].payload);

  let loser: [string, ManualUpsert] | null = null;
  for (const entry of ups) {
    if (entry[0] === maxUp[0]) continue;
    if (ancestors.has(entry[0])) continue; // causally superseded — resolved
    if (signature(entry[1].payload) === winnerSig) continue; // same value — no conflict
    if (!loser || cmpTuple([entry[1].t, entry[1].d, entry[0]], [loser[1].t, loser[1].d, loser[0]]) > 0) loser = entry;
  }

  return {
    ...maxUp[1].payload,
    id: entityId,
    deletedAt: null,
    hasConflict: loser !== null,
    conflictPayload: loser ? JSON.stringify(loser[1].payload) : null,
  };
}

// --- the hook -------------------------------------------------------------------------

export interface PolicyApplyOptions {
  /** Policy per entity type — typically backed by `GET /sync/schema`. Return
   *  `'LWW'` for unknown types to match the built-in behaviour. */
  policyFor: (entityType: string) => SyncPolicy;
  /**
   * Dexie table holding per-entity merge bookkeeping. MUST be declared in
   * `SyncConfig.tables` as `{ [metaTable]: 'key' }`. Default `'_syncmeta'`.
   */
  metaTable?: string;
  /** Author id of server-authored fan-out mutations, applied verbatim.
   *  Default `SYSTEM_AUTHOR` ('system'). */
  systemAuthorId?: string;
}

/**
 * Build an {@link ApplyMutationHook} that merges every pulled mutation per its
 * entity's declared policy. See the module doc for wiring and semantics.
 */
export function policyApply(opts: PolicyApplyOptions): ApplyMutationHook {
  const metaTableName = opts.metaTable ?? '_syncmeta';
  const systemAuthor = opts.systemAuthorId ?? SYSTEM_AUTHOR;

  return async (db: MaayoDatabase, mutation: Mutation): Promise<ApplyOutcome> => {
    let table;
    try {
      table = db.table<Record<string, unknown>, string>(mutation.entityType);
    } catch {
      return 'skipped'; // unknown entity type — same as the default apply
    }
    let payload: Record<string, unknown>;
    try {
      payload = mutation.payload ? (JSON.parse(mutation.payload) as Record<string, unknown>) : {};
    } catch {
      return 'skipped'; // malformed payload must never poison the pull
    }

    // Server-authored fan-out (e.g. MANUAL conflict state): authoritative
    // materialised snapshot, merged verbatim outside per-policy gating.
    if (mutation.op === 'PATCH' && mutation.authorIdentityId === systemAuthor) {
      const existing = await table.get(mutation.entityId);
      await table.put({ ...(existing ?? {}), ...payload, id: mutation.entityId });
      return 'applied';
    }

    const metaTable = db.table<PolicyMeta, string>(metaTableName);
    const key = keyOf(mutation.entityType, mutation.entityId);
    const [existing, meta] = await Promise.all([table.get(mutation.entityId), metaTable.get(key)]);
    const decision = applyPolicyMutation(existing, meta, mutation, payload, opts.policyFor(mutation.entityType));
    if (decision.action === 'put' && decision.row) await table.put(decision.row);
    await metaTable.put(decision.meta);
    return decision.action === 'put' ? 'applied' : 'skipped';
  };
}
