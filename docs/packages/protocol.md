# @maayo/protocol

TypeScript types for the Maayo sync protocol. Zero runtime dependencies — types only.

## Install

```bash
pnpm add @maayo/protocol
```

## Types

### `Mutation`

```typescript
interface Mutation {
  id: string;               // ULID — 26 chars, idempotency key
  channel: string;          // e.g. "org:abc/school:xyz"
  entityType: string;       // PascalCase, e.g. "Student"
  entityId: string;         // UUID of the affected record
  op: MutationOp;
  payload: string;          // JSON-serialised entity snapshot
  authorIdentityId: string;
  deviceId: string;         // stable per-browser UUID
  clientTs: string;         // ISO-8601
  parentIds: string[];      // causal deps (reserved, use [])
}

type MutationOp = 'CREATE' | 'UPDATE' | 'DELETE' | 'PATCH';
```

### `BatchMutationsRequest` / `BatchMutationsResponse`

```typescript
interface BatchMutationsRequest {
  mutations: Mutation[];
}

interface BatchMutationsResponse {
  accepted: AcceptedMutation[];
  rejected: RejectedMutation[];
}

interface AcceptedMutation {
  id: string;
  receivedAt: string;   // ISO-8601 server timestamp
}

interface RejectedMutation {
  id: string;
  reason: string;
}
```

### `ChangesResponse` / `ChangesQuery`

```typescript
interface ChangesResponse {
  channel: string;
  mutations: Mutation[];
  cursor: Cursor;
  hasMore: boolean;
}

interface Cursor {
  lastMutationId: string | null;
  lastReceivedAt: string | null;
}

interface ChangesQuery {
  channel: string;
  since?: string;    // ISO-8601
  limit?: number;
}
```

## Usage

These types are consumed automatically by `@maayo/client`, `@maayo/angular`, and `@maayo/spring`. Import them directly when implementing a custom backend adapter or when typing API responses in your application:

```typescript
import type { Mutation, BatchMutationsResponse, ChangesResponse } from '@maayo/protocol';
```
