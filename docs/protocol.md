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
  "rejected": []
}
```

Every mutation in the request must appear in exactly one of `accepted` or `rejected`.

### Server contract

- **Idempotent**: if `id` already exists, re-accept it without saving again.
- **Validate**: reject mutations with a blank `id`.
- **Authorise**: optionally check the caller is allowed to push to `channel`.
- **Atomic per mutation**: partial success is fine — the client retries only rejected IDs.

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
| Channel forbidden | `403` (changes) or mutation in `rejected` | Skip channel / log |
| Server error | `5xx` | `SyncStatus → 'error'`, retry next cycle |
| Offline | — | `SyncStatus → 'offline'`, outbox drains on reconnect |
