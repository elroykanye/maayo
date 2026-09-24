export { openDatabase } from './database';
export type { MaayoDatabase, OutboxRow, CursorRow, HistoryRow, LwwWinnerRow, MigrationDef, UserTableSchema } from './database';

export {
  enqueue,
  pending,
  markSynced,
  purgeSynced,
  recordRejection,
  rejected,
  retryRejected,
  discardRejected,
  rejectionBackoff,
} from './outbox';
export type { EnqueueOptions, RejectionOptions, RecordedRejection } from './outbox';

export { pull, SyncHttpError, CheckpointRequiredError } from './pull';
export type { PullOptions, ApplyResult, ApplyOutcome, ApplyMutationHook } from './pull';

export { policyApply, applyPolicyMutation } from './policies';
export type { PolicyApplyOptions, PolicyMeta, PolicyDecision, StoredTuple } from './policies';

export { foldPolicies, checkConvergence, assertConverges, canonicalState } from './testing';
export type { FoldFn, FoldedState, FoldedEntity, ConvergenceOptions, ConvergenceReport } from './testing';

export { SyncEngine } from './engine';
export type { SyncConfig, SyncStatus, SyncPhase, SyncTelemetryEvent, CheckpointSyncConfig } from './engine';

export { applyMutationPage } from './bulk';
export type { MutationPage, ApplyMutationPageOptions } from './bulk';

export {
  CHECKPOINT_PROTOCOL_VERSION,
  computeCheckpointChecksum,
  installCheckpoint,
  evictCheckpointChannel,
} from './checkpoint';
export type {
  CheckpointEnvelope,
  CheckpointRow,
  CheckpointInstallOptions,
} from './checkpoint';

export { ulid, deviceId } from './ids';

export { channelFor, channelsFromGrants } from './channel';

export { WorkingSetRegistry } from './working-set';
export type {
  WorkingSetDescriptor,
  WorkingSetMode,
  WorkingSetEntry,
  WorkingSetRegistryOptions,
} from './working-set';

export {
  installSnapshotPack,
  installSnapshotPackFromHttp,
  MemorySnapshotChunkCache,
} from './snapshot-pack';
export type {
  SnapshotChunkCache,
  SnapshotPackInstallOptions,
  SnapshotChunkFetcher,
  SnapshotPackHttpOptions,
} from './snapshot-pack';
