# @maayo/protocol

Shared TypeScript types for the Maayo offline-first sync protocol.

This package contains only type definitions — no runtime code. It is consumed by `@maayo/client` and any backend adapter that wants type-safe request/response shapes.

## Install

```bash
npm install @maayo/protocol
```

## Types

| Type | Description |
|------|-------------|
| `Mutation` | A single write operation queued by the client |
| `BatchMutationsRequest` | Request body for `POST /sync/mutations` |
| `BatchMutationsResponse` | Response body with accepted/rejected mutations |
| `ChangesResponse` | Response body for `GET /sync/changes` |
| `Cursor` | Pagination cursor returned with each changes page |

## Protocol overview

Two endpoints, any backend language:

```
POST /sync/mutations   — client pushes queued writes
GET  /sync/changes     — client pulls server-side deltas
```

See [@maayo/client](https://www.npmjs.com/package/@maayo/client) for the full offline-first sync engine.
