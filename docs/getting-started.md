# Getting Started

Maayo solves one problem: your app needs to work offline and sync data when the network comes back. Writes land in a local IndexedDB outbox immediately; the sync engine drains that outbox to the server in the background. Reads come from the local database, kept fresh by pulling server deltas.

## What you need

**Client**: `@maayo/client` + `@maayo/angular` (or your framework adapter)  
**Server**: any backend that implements two HTTP endpoints — `POST /sync/mutations` and `GET /sync/changes`. No specific database required.

---

## 1. Install

```bash
pnpm add @maayo/client @maayo/angular dexie
```

---

## 2. Configure Angular

```typescript
// app.config.ts
import { provideSync, channelsFromGrants } from '@maayo/angular';

export const appConfig: ApplicationConfig = {
  providers: [
    provideHttpClient(),
    provideSync({
      baseUrl: 'https://api.example.com',
      dbName: 'myapp',
      tables: {
        student: 'id, schoolId, name',   // Dexie index spec per entity
      },
      authHeaders: () => ({ Authorization: `Bearer ${getToken()}` }),
      channels: (injector) => {
        const auth = injector.get(AuthStore);
        return channelsFromGrants(auth.grants(), (g) => ({
          org: g.orgId,
          school: g.schoolId,
        }));
      },
    }),
  ],
};
```

---

## 3. Read data (signals, live)

```typescript
@Component({ /* ... */ })
export class StudentsComponent {
  readonly students = syncCollection<Student>('student');  // Signal<Student[]>
  readonly status = injectSyncStatus();                    // Signal<SyncStatus>
}
```

`syncCollection` stays live — it updates automatically when a sync pull writes new data to IndexedDB.

---

## 4. Write data

```typescript
const engine = inject(SYNC_ENGINE);

await enqueue(engine.db, {
  channel: 'org:abc/school:xyz',
  entityType: 'Student',
  entityId: crypto.randomUUID(),
  op: 'CREATE',
  payload: { id: '...', name: 'Ada Lovelace', updatedAt: new Date().toISOString() },
  authorIdentityId: currentUserId,
});
// Queued locally. Synced to server on the next push cycle (within 10 s by default).
```

---

## 5. Server — choose your database

The server just needs to implement `MaayoRepository` (Kotlin/Spring) or the two endpoint contracts (any other backend). There is no required database.

### Spring Boot — zero config with JPA

If Spring Data JPA is already on your classpath, add the dependency and you're done:

```kotlin
implementation("dev.maayo:maayo-spring:0.3.1")
```

The JPA adapter auto-configures a `maayo_mutation` table. No YAML needed.

### Spring Boot — bring your own store (MongoDB, DynamoDB, JDBC, …)

```kotlin
implementation("dev.maayo:maayo-spring:0.3.1")
```

Implement `MaayoRepository` for your store and register it as a bean:

```kotlin
@Component
class MongoMaayoRepository(private val mongo: MongoTemplate) : MaayoRepository {

    override fun existsById(id: String) =
        mongo.exists(Query(Criteria.where("maayoId").`is`(id)), MaayoDocument::class.java)

    override fun saveAll(mutations: List<Mutation>): List<SavedMutation> {
        val now = Instant.now()
        return mutations.map { m ->
            val doc = MaayoDocument(maayoId = m.id, /* ... */ receivedAt = now)
            mongo.save(doc)
            SavedMutation(m, now)
        }
    }

    override fun findChanges(channel: String, since: Instant?, limit: Int): List<SavedMutation> {
        val criteria = Criteria.where("channel").regex("^${Regex.escape(channel)}(/.*)?$")
        since?.let { criteria.and("receivedAt").gt(it) }
        val query = Query(criteria).with(Sort.by("receivedAt", "maayoId")).limit(limit)
        return mongo.find(query, MaayoDocument::class.java).map { it.toSaved() }
    }

    override fun findChanges(
        channel: String,
        since: Instant?,
        lastMutationId: String?,
        limit: Int,
    ): List<SavedMutation> {
        if (since == null || lastMutationId == null) return findChanges(channel, since, limit)
        val channelCriteria = Criteria.where("channel").regex("^${Regex.escape(channel)}(/.*)?$")
        val cursorCriteria = Criteria().orOperator(
            Criteria.where("receivedAt").gt(since),
            Criteria().andOperator(
                Criteria.where("receivedAt").`is`(since),
                Criteria.where("maayoId").gt(lastMutationId),
            ),
        )
        val criteria = Criteria().andOperator(channelCriteria, cursorCriteria)
        val query = Query(criteria).with(Sort.by("receivedAt", "maayoId")).limit(limit)
        return mongo.find(query, MaayoDocument::class.java).map { it.toSaved() }
    }
}
```

The two controllers (`POST /sync/mutations`, `GET /sync/changes`) register automatically once a `MaayoRepository` bean is present. The compound overload is required for continuation pages; its default fails explicitly so a timestamp-only fallback cannot drop tied rows.

### Any other backend

Implement the [protocol spec](./protocol.md) directly — two endpoints, any language, any database.

---

## What happens at runtime

1. `provideSync` starts `SyncEngine` on app init.
2. Every 10 s: push queued outbox rows → pull deltas per channel.
3. Pulled mutations apply to IndexedDB via LWW (`updatedAt` comparison).
4. `syncCollection` signals re-emit → components re-render.
5. Offline: writes queue in outbox, pulls are skipped. On reconnect, the next cycle catches up automatically.
