# Protocol Specification

Maayo requires exactly two HTTP endpoints. Implement these on any backend to become a Maayo server.

## POST /sync/mutations

Push a batch of local mutations to the server.

### Request

```http
POST /sync/mutations
Content-Type: application/json
Authorization: Bearer <token>
```

```json
{
  "mutations": [
    {
      "id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "channel": "org:abc/school:xyz",
      "entityType": "Student",
      "entityId": "550e8400-e29b-41d4-a716-446655440000",
      "op": "CREATE",
      "payload": "{\"id\":\"550e8400-...\",\"name\":\"Ada Lovelace\",\"updatedAt\":\"2026-01-15T09:00:00Z\"}",
      "authorIdentityId": "user-123",
      "deviceId": "7f4a8c2e-...",
      "clientTs": "2026-01-15T09:00:00.123Z",
      "parentIds": []
    }
  ]
}
```

### Mutation fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string (ULID) | Idempotency key — 26 Crockford base-32 chars |
| `channel` | string | Target channel, e.g. `org:abc/school:xyz` |
| `entityType` | string | PascalCase table name, e.g. `Student` |
| `entityId` | string (UUID) | Primary key of the affected record |
| `op` | `CREATE \| UPDATE \| DELETE \| PATCH` | Operation type |
| `payload` | string | JSON-serialised entity snapshot |
| `authorIdentityId` | string | Identity ID of the author |
| `deviceId` | string | Stable per-browser UUID |
| `clientTs` | string (ISO-8601) | Client-side timestamp |
| `parentIds` | string[] | Causal dependencies (reserved, send `[]`) |

### Response `200 OK`

```json
{
  "accepted": [
    { "id": "01ARZ3NDEKTSV4RRFFQ69G5FAV", "receivedAt": "2026-01-15T09:00:00.500Z" }
  ],
  "rejected": [
    { "id": "01ARZ3NDEKTSV4RRFFQ69G5FB0", "reason": "slug already taken", "code": "SLUG_TAKEN" }
  ]
}
```

Every mutation in the request must appear in exactly one of `accepted` or `rejected`.

A rejection carries a human-readable `reason` (safe to surface in a UI) and an
optional machine-readable `code`. Codes let the client distinguish PERMANENT
rejections — retrying can never succeed, e.g. a uniqueness conflict — from
transient ones: list them in `SyncConfig.permanentRejectCodes` and the row is
quarantined immediately instead of burning its retry budget.

### Server contract

- **Idempotent**: if `id` already exists, re-accept it without saving again.
- **Validate**: reject mutations with a blank `id`.
- **Authorise**: optionally check the caller is allowed to push to `channel`.
- **Atomic per mutation**: partial success is fine — the client retries only rejected IDs.

### Client behaviour on rejection

Each rejection bumps the outbox row's attempt counter and schedules an
exponential re-push backoff (30s doubling to a 30min cap). After
`maxRejectAttempts` rejections (default 5) — or immediately for a permanent
`code` — the row is **quarantined**: it leaves the push loop but is never
silently discarded. `SyncConfig.onReject` fires on every rejection with the
row and whether it was quarantined; `rejected(db)` lists the quarantine,
`retryRejected(db, id)` revives a row (preserving its original `clientTs` and
`parentIds` — a retry keeps its causal position), `discardRejected(db, id)`
drops it for good.

---

## GET /sync/changes

Pull server-side mutations for a channel since a cursor.

### Request

```http
GET /sync/changes?channel=org:abc/school:xyz&since=2026-01-15T08:00:00Z&limit=500
Authorization: Bearer <token>
```

### Query parameters

| Param | Required | Description |
|-------|----------|-------------|
| `channel` | yes | Channel to pull from |
| `since` | no | ISO-8601 — return only mutations received after this time |
| `limit` | no | Max mutations per page (server default: 500, max: 2000) |

### Response `200 OK`

```json
{
  "channel": "org:abc/school:xyz",
  "mutations": [ /* ... same shape as push */ ],
  "cursor": {
    "lastMutationId": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "lastReceivedAt": "2026-01-15T09:00:00.500Z"
  },
  "hasMore": false
}
```

### Server contract

- **Hierarchy**: return mutations whose channel equals `channel` **or** starts with `channel/`. Pulling `org:abc` includes `org:abc/school:xyz/...`.
- **Ordered**: return mutations ascending by `receivedAt`.
- **Paginated**: if more rows exist beyond `limit`, set `hasMore: true`. The client will immediately re-pull.
- **Authorise**: return `403` if the caller is not allowed to pull from `channel`.

---

## Auth

The protocol is auth-agnostic. Pass credentials however your backend expects (Bearer token, session cookie, API key). Supply them to the client via `authHeaders`:

```typescript
provideSync({
  baseUrl: 'https://api.example.com',
  authHeaders: () => ({ Authorization: `Bearer ${getToken()}` }),
  channels: ['org:abc/school:xyz'],
});
```

---

## Error handling

| Scenario | Server response | Client behaviour |
|----------|----------------|-----------------|
| Auth failure | `401` | `SyncStatus → 'error'`, retry next cycle |
| Channel forbidden | `403` (changes) or mutation in `rejected` | Skip channel / backoff + quarantine (see above) |
| Server error | `5xx` | `SyncStatus → 'error'`, retry next cycle |
| Offline | — | `SyncStatus → 'offline'`, outbox drains on reconnect |
