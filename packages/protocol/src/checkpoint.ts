import type { Cursor } from './changes';

/** Wire version of the optional checkpoint-clone capability. */
export const CHECKPOINT_PROTOCOL_VERSION = 1 as const;

/** Stable error code returned when the requested replay cursor was compacted. */
export const CHECKPOINT_REQUIRED = 'CHECKPOINT_REQUIRED' as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue }

/** One already-materialized consumer row. Values are JSON objects, not JSON strings. */
export interface CheckpointMaterializedRow {
  entityType: string;
  entityId: string;
  payload: JsonObject;
}

/** Opaque per-entity merge state needed to apply future mutations deterministically. */
export interface CheckpointMergeMetadata {
  entityType: string;
  entityId: string;
  value: JsonObject;
}

/** Standard merge metadata used by the client's built-in LWW policy. Keeping
 * this tuple outside bounded audit history preserves deterministic ties. */
export interface CheckpointLwwMergeMetadataValue extends JsonObject {
  policy: 'LWW';
  clientTs: string;
  deviceId: string;
  mutationId: string;
}

export interface CheckpointIntegrity {
  algorithm: 'sha-256';
  /** Hex, base64, or base64url SHA-256 digest supplied by the checkpoint producer. */
  checksum: string;
  /** The digest covers the canonical rows and mergeMetadata payload. */
  scope: 'rows-and-merge-metadata';
}

/** Response body of the optional `GET /sync/checkpoint` endpoint. */
export interface CheckpointEnvelope {
  protocolVersion: typeof CHECKPOINT_PROTOCOL_VERSION;
  schemaVersion: string;
  channel: string;
  /** Authorization/projection partition; never reuse a checkpoint across keys. */
  projectionKey: string;
  /** Application-defined revision of the projection/grant/schema inputs. */
  projectionRevision: string;
  /** The consistent log boundary represented by rows and mergeMetadata. */
  throughCursor: Cursor;
  rows: CheckpointMaterializedRow[];
  mergeMetadata: CheckpointMergeMetadata[];
  integrity: CheckpointIntegrity;
}

export interface CheckpointProviderContext<TRequest = unknown> {
  request: TRequest;
  channel: string;
  projectionKey: string;
  /** Conditional request value, if supplied by the client. */
  ifNoneMatch?: string;
}

/**
 * Application seam for building/caching checkpoints from a consistent view.
 * Generic adapters cannot infer consumer tables or authorization projections.
 */
export interface CheckpointProvider<TRequest = unknown> {
  getCheckpoint(context: CheckpointProviderContext<TRequest>): Promise<CheckpointEnvelope | null>;
}

export interface CheckpointRequiredResponse {
  code: typeof CHECKPOINT_REQUIRED;
  channel: string;
}

export function isCheckpointEnvelope(value: unknown): value is CheckpointEnvelope {
  if (!isRecord(value)) return false;
  if (value.protocolVersion !== CHECKPOINT_PROTOCOL_VERSION) return false;
  if (!isNonEmptyString(value.schemaVersion)
    || !isNonEmptyString(value.channel)
    || !isNonEmptyString(value.projectionKey)
    || !isNonEmptyString(value.projectionRevision)) return false;
  if (!isCursor(value.throughCursor)) return false;
  if (!Array.isArray(value.rows) || !value.rows.every(isMaterializedRow)) return false;
  if (!Array.isArray(value.mergeMetadata) || !value.mergeMetadata.every(isMergeMetadata)) return false;
  if (!isIntegrity(value.integrity)) return false;
  return hasUniqueEntityKeys(value.rows) && hasUniqueEntityKeys(value.mergeMetadata);
}

export function isCheckpointRequiredResponse(value: unknown): value is CheckpointRequiredResponse {
  return isRecord(value)
    && value.code === CHECKPOINT_REQUIRED
    && isNonEmptyString(value.channel);
}

function isMaterializedRow(value: unknown): value is CheckpointMaterializedRow {
  return isRecord(value)
    && isNonEmptyString(value.entityType)
    && isNonEmptyString(value.entityId)
    && isJsonObject(value.payload);
}

function isMergeMetadata(value: unknown): value is CheckpointMergeMetadata {
  return isRecord(value)
    && isNonEmptyString(value.entityType)
    && isNonEmptyString(value.entityId)
    && isJsonObject(value.value);
}

function isIntegrity(value: unknown): value is CheckpointIntegrity {
  return isRecord(value)
    && value.algorithm === 'sha-256'
    && value.scope === 'rows-and-merge-metadata'
    && typeof value.checksum === 'string'
    && /^(?:[a-fA-F0-9]{64}|[A-Za-z0-9+/_-]{43}=?)$/.test(value.checksum);
}

function isCursor(value: unknown): value is Cursor {
  if (!isRecord(value)) return false;
  const id = value.lastMutationId;
  const receivedAt = value.lastReceivedAt;
  if (id === null && receivedAt === null) return true;
  return isNonEmptyString(id)
    && isNonEmptyString(receivedAt)
    && !Number.isNaN(Date.parse(receivedAt));
}

function isJsonObject(value: unknown): value is JsonObject {
  return isJsonValue(value, new Set()) && isRecord(value);
}

function isJsonValue(value: unknown, ancestors: Set<object>): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isJsonValue(entry, ancestors))
    : Object.getPrototypeOf(value) === Object.prototype
      && Object.values(value).every((entry) => isJsonValue(entry, ancestors));
  ancestors.delete(value);
  return valid;
}

function hasUniqueEntityKeys(rows: Array<{ entityType: string; entityId: string }>): boolean {
  const keys = new Set<string>();
  for (const row of rows) {
    const key = `${row.entityType}\u0000${row.entityId}`;
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
