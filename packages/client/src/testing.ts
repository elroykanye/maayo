/**
 * Convergence test harness — prove a merge function is order-independent.
 *
 * The operational definition of "replicas converge": two devices that received
 * the same mutations in DIFFERENT orders must end up in identical state. The
 * harness folds a mutation set through an apply function in many orders (all
 * permutations when small, seeded shuffles otherwise) and reports whether every
 * order produced the same canonical state.
 *
 * Use it to gate your own `applyMutation` hooks — and the built-in
 * {@link foldPolicies} adapter to verify a policy map:
 *
 * ```ts
 * const state = assertConverges(mutations, (ms) => foldPolicies(ms, policyFor));
 * expect(state['Student#s1'].row?.name).toBe('Ada');
 * ```
 *
 * Pure and dependency-free (a seeded RNG makes failures reproducible) — safe to
 * import in any test runner without touching IndexedDB.
 */
import type { Mutation, SyncPolicy } from '@maayo/protocol';
import { applyPolicyMutation, type PolicyMeta } from './policies';

/** Materialised view of one entity after a fold: the row (or undefined if the
 * entity was never written) — tombstones are rows with `deletedAt` set. */
export interface FoldedEntity {
  entityType: string;
  entityId: string;
  row?: Record<string, unknown>;
}

/** Final state keyed by `${entityType}#${entityId}`. */
export type FoldedState = Record<string, FoldedEntity>;

export type FoldFn = (mutations: Mutation[]) => FoldedState;

/**
 * Pure in-memory fold of the policy-aware merge (`policies.ts`) — the same
 * per-mutation decisions the live `policyApply` hook makes against Dexie,
 * without a database. The reference implementation to test against.
 */
export function foldPolicies(mutations: Mutation[], policyFor: (entityType: string) => SyncPolicy): FoldedState {
  const rows = new Map<string, Record<string, unknown>>();
  const metas = new Map<string, PolicyMeta>();

  for (const m of mutations) {
    const key = `${m.entityType}#${m.entityId}`;
    let payload: Record<string, unknown> = {};
    try {
      payload = m.payload ? (JSON.parse(m.payload) as Record<string, unknown>) : {};
    } catch {
      continue;
    }
    if (m.op === 'PATCH' && m.authorIdentityId === 'system') {
      rows.set(key, { ...(rows.get(key) ?? {}), ...payload, id: m.entityId });
      continue;
    }
    const decision = applyPolicyMutation(rows.get(key), metas.get(key), m, payload, policyFor(m.entityType));
    metas.set(key, decision.meta);
    if (decision.action === 'put' && decision.row) rows.set(key, decision.row);
  }

  const out: FoldedState = {};
  for (const [key, meta] of metas) {
    const [entityType] = key.split('#');
    out[key] = { entityType, entityId: meta.key.slice(entityType.length + 1), row: rows.get(key) };
  }
  return out;
}

/** Deterministic PRNG (mulberry32) so a divergence reproduces from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const result: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) result.push([items[i], ...p]);
  }
  return result;
}

export interface ConvergenceOptions {
  /** Use exhaustive permutations while n! ≤ this (default 120 → n ≤ 5). */
  maxPerms?: number;
  /** Seeded random orders when the set is too large to permute. Default 200. */
  randomOrders?: number;
  seed?: number;
}

/** Canonical, key-sorted JSON so field order never produces a false diff. */
export function canonicalState(state: FoldedState): string {
  const keys = Object.keys(state).sort();
  return JSON.stringify(
    keys.map((k) => {
      const row = state[k].row;
      const sorted = row
        ? Object.fromEntries(Object.entries(row).sort(([a], [b]) => (a < b ? -1 : 1)))
        : null;
      return [k, sorted];
    }),
  );
}

export interface ConvergenceReport {
  converged: boolean;
  /** Distinct final states seen — canonical form → one order that produced it. */
  distinct: Map<string, Mutation[]>;
  ordersTried: number;
}

/** Fold `mutations` through `fold` in many orders; report the distinct outcomes. */
export function checkConvergence(
  mutations: Mutation[],
  fold: FoldFn,
  opts: ConvergenceOptions = {},
): ConvergenceReport {
  const { maxPerms = 120, randomOrders = 200, seed = 0xc0ffee } = opts;
  const factorial = (x: number): number => (x <= 1 ? 1 : x * factorial(x - 1));

  let orders: Mutation[][];
  if (mutations.length <= 1) {
    orders = [mutations.slice()];
  } else if (factorial(mutations.length) <= maxPerms) {
    orders = permutations(mutations);
  } else {
    const rng = mulberry32(seed);
    orders = [mutations.slice()];
    for (let i = 0; i < randomOrders; i++) orders.push(shuffle(mutations, rng));
  }

  const distinct = new Map<string, Mutation[]>();
  for (const order of orders) {
    const c = canonicalState(fold(order));
    if (!distinct.has(c)) distinct.set(c, order);
  }
  return { converged: distinct.size === 1, distinct, ordersTried: orders.length };
}

/**
 * Assert order-independent convergence; throws a diff-rich error when any two
 * orders disagree. Returns the (single) converged state.
 */
export function assertConverges(mutations: Mutation[], fold: FoldFn, opts?: ConvergenceOptions): FoldedState {
  const report = checkConvergence(mutations, fold, opts);
  if (!report.converged) {
    const samples = [...report.distinct.entries()]
      .slice(0, 3)
      .map(([state, order], i) => `  state ${i + 1} from order [${order.map((m) => m.id).join(', ')}]:\n    ${state}`)
      .join('\n');
    throw new Error(
      `NON-CONVERGENT: ${report.distinct.size} distinct final states across ${report.ordersTried} orders:\n${samples}`,
    );
  }
  return fold(mutations);
}
