# @maayo/protocol

[![npm version](https://img.shields.io/npm/v/@maayo/protocol?style=flat-square)](https://www.npmjs.com/package/@maayo/protocol)
[![npm downloads](https://img.shields.io/npm/dm/@maayo/protocol?style=flat-square)](https://www.npmjs.com/package/@maayo/protocol)
[![CI](https://github.com/elroykanye/maayo/actions/workflows/ci.yml/badge.svg)](https://github.com/elroykanye/maayo/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](https://github.com/elroykanye/maayo/blob/main/LICENSE)

Shared TypeScript types for the [Maayo](https://github.com/elroykanye/maayo) offline-first sync protocol. Zero runtime dependencies — types only.

## Install

```bash
npm install @maayo/protocol
```

## Types

| Type | Description |
|------|-------------|
| `Mutation` | A single write operation queued by the client |
| `BatchMutationsRequest` | Body for `POST /sync/mutations` |
| `BatchMutationsResponse` | Response with accepted/rejected mutations |
| `ChangesResponse` | Body for `GET /sync/changes` |
| `Cursor` | Pagination cursor returned with each changes page |

## Protocol overview

Two endpoints, any backend language:

```
POST /sync/mutations   — client pushes queued writes
GET  /sync/changes     — client pulls server-side deltas
```

## Related packages

- [`@maayo/client`](https://www.npmjs.com/package/@maayo/client) — full offline-first sync engine
- [`@maayo/react`](https://www.npmjs.com/package/@maayo/react) — React / Next.js hooks
- [`@maayo/angular`](https://www.npmjs.com/package/@maayo/angular) — Angular signals + DI
