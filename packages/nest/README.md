# @maayo/nest

[![npm version](https://img.shields.io/npm/v/@maayo/nest?style=flat-square)](https://www.npmjs.com/package/@maayo/nest)
[![npm downloads](https://img.shields.io/npm/dm/@maayo/nest?style=flat-square)](https://www.npmjs.com/package/@maayo/nest)
[![CI](https://github.com/elroykanye/maayo/actions/workflows/ci.yml/badge.svg)](https://github.com/elroykanye/maayo/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](https://github.com/elroykanye/maayo/blob/main/LICENSE)

NestJS adapter for [Maayo](https://github.com/elroykanye/maayo) — wires `POST /sync/mutations` and `GET /sync/changes` into your NestJS application with a single `MaayoModule.forRoot()` call.

Requires NestJS 10+.

## Install

```bash
npm install @maayo/nest @maayo/protocol
```

## Quick start

### 1. Implement `MaayoStore`

Maayo is database-agnostic. Implement the `MaayoStore` interface using any ORM:

```ts
import { Injectable } from '@nestjs/common';
import type { MaayoStore, SavedMutation } from '@maayo/nest';
import { DuplicateMutationError, type Mutation } from '@maayo/protocol';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MutationRecord } from './mutation-record.entity';

@Injectable()
export class TypeOrmMaayoStore implements MaayoStore {
  constructor(
    @InjectRepository(MutationRecord)
    private readonly repo: Repository<MutationRecord>,
  ) {}

  async existsById(id: string) {
    return this.repo.existsBy({ maayoId: id });
  }

  async saveAll(mutations: Mutation[]): Promise<SavedMutation[]> {
    const receivedAt = new Date();
    const records = this.repo.create(mutations.map(m => ({ ...m, maayoId: m.id, receivedAt })));
    await this.repo.save(records);
    return mutations.map(mutation => ({ mutation, receivedAt }));
  }

  async findChanges(channel: string, since: Date | null, limit: number): Promise<SavedMutation[]> {
    const qb = this.repo.createQueryBuilder('m')
      .where('(m.channel = :ch OR m.channel LIKE :prefix)', { ch: channel, prefix: `${channel}/%` })
      .orderBy('m.receivedAt', 'ASC')
      .addOrderBy('m.maayoId', 'ASC')
      .limit(limit);
    if (since) qb.andWhere('m.receivedAt > :since', { since });
    const records = await qb.getMany();
    return records.map(r => ({ mutation: r as unknown as Mutation, receivedAt: r.receivedAt }));
  }

  async findChangesByCursor(
    channel: string,
    since: Date,
    lastMutationId: string,
    limit: number,
  ): Promise<SavedMutation[]> {
    const records = await this.repo.createQueryBuilder('m')
      .where('(m.channel = :ch OR m.channel LIKE :prefix)', { ch: channel, prefix: `${channel}/%` })
      .andWhere('(m.receivedAt > :since OR (m.receivedAt = :since AND m.maayoId > :lastMutationId))', {
        since,
        lastMutationId,
      })
      .orderBy('m.receivedAt', 'ASC')
      .addOrderBy('m.maayoId', 'ASC')
      .limit(limit)
      .getMany();
    return records.map(r => ({ mutation: r as unknown as Mutation, receivedAt: r.receivedAt }));
  }
}
```

`saveAll` must enforce a unique mutation-ID constraint atomically. If that specific constraint
loses a race, translate the database error to `DuplicateMutationError`; do not translate connection,
transaction, or other persistence failures.

### 2. Register `MaayoModule` in your app

```ts
// app.module.ts
import { Module } from '@nestjs/common';
import { MaayoModule } from '@maayo/nest';
import { TypeOrmMaayoStore } from './maayo.store';

@Module({
  imports: [
    MaayoModule.forRoot({
      store: new TypeOrmMaayoStore(/* inject repo */),
    }),
  ],
})
export class AppModule {}
```

Or with async options (recommended for DI):

```ts
MaayoModule.forRootAsync({
  imports: [TypeOrmModule.forFeature([MutationRecord])],
  useFactory: (store: TypeOrmMaayoStore) => ({ store }),
  inject: [TypeOrmMaayoStore],
})
```

That's it. Your NestJS app now serves:
- `POST /sync/mutations`
- `GET /sync/changes`

## API

### `MaayoModule.forRoot(options)`

| Option | Type | Description |
|--------|------|-------------|
| `store` | `MaayoStore` | Required. Your persistence implementation. |
| `authorizer` | `ChannelAuthorizer` | Optional. Channel-level RBAC. Defaults to permit-all. |
| `defaultLimit` | `number` | Max mutations per changes page. Default `500`. |

### `MaayoStore` interface

| Method | Description |
|--------|-------------|
| `existsById(id)` | Return true if the ULID was already accepted (idempotency check) |
| `saveAll(mutations)` | Persist a batch; return each with a server-assigned `receivedAt` |
| `findChanges(channel, since, limit)` | Return the first page for a channel and sub-channels, ordered by `(receivedAt, id)` |
| `findChangesByCursor(channel, since, lastMutationId, limit)` | Optional source-compatible seam required for continuation pages; continue strictly after the pair |

The endpoint accepts either neither cursor field or both `since` and `lastMutationId`. Incomplete or
invalid cursors return `400`. A continuation against a store without `findChangesByCursor` returns
`501` rather than falling back to timestamp-only pagination.

### `ChannelAuthorizer` interface

```ts
import { Injectable } from '@nestjs/common';
import type { ChannelAuthorizer } from '@maayo/nest';

@Injectable()
export class JwtChannelAuthorizer implements ChannelAuthorizer {
  canPush(req: unknown, channel: string) {
    const user = (req as any).user;
    return user?.grants?.some((g: string) => channel.startsWith(g)) ?? false;
  }
  canPull(req: unknown, channel: string) {
    return this.canPush(req, channel);
  }
}
```

## Related

- [`@maayo/client`](https://www.npmjs.com/package/@maayo/client) — browser sync engine
- [`@maayo/react`](https://www.npmjs.com/package/@maayo/react) — React / Next.js hooks
- [`@maayo/angular`](https://www.npmjs.com/package/@maayo/angular) — Angular signals adapter
- Spring Boot adapter — [GitHub Packages](https://github.com/elroykanye/maayo/packages) (`dev.maayo:maayo-spring`)
