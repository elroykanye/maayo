# @maayo/express

Express adapter for Maayo's mutation, delta, and optional checkpoint-clone endpoints.

```ts
app.use('/sync', maayoRouter({
  store,
  authorizer,
  checkpointProvider,
  checkpointProjectionKey: (request, channel) =>
    `${request.user.id}:${request.user.grantsRevision}:${channel}`,
}));
```

Checkpoint support is optional. When enabled, the application owns the consistent
`CheckpointProvider` and must partition `checkpointProjectionKey` by every identity, role, tenant,
grant, and schema input that affects visible rows. If the store archives replay history, implement
`isCursorRetained`; stale cursors must return `CHECKPOINT_REQUIRED` before reading a partial tail.

The endpoint serves private projection-scoped ETags and gzip/Brotli. Replay-only servers can omit
the provider and continue serving `POST /sync/mutations` and `GET /sync/changes` unchanged.
