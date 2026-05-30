# Getting Started

This guide wires up an Angular frontend and a Spring Boot backend in about 5 minutes.

## Prerequisites

- Node 20+ with pnpm
- Java 17+, Gradle
- A running Postgres database (or use H2 for local dev)

---

## 1. Install packages

```bash
pnpm add @maayo/client @maayo/angular
pnpm add @maayo/protocol   # optional — TypeScript types only
```

---

## 2. Configure the Angular app

```typescript
// app.config.ts
import { ApplicationConfig } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideSync, channelsFromGrants } from '@maayo/angular';

export const appConfig: ApplicationConfig = {
  providers: [
    provideHttpClient(),
    provideSync({
      baseUrl: 'https://api.example.com',
      dbName: 'myapp',
      tables: {
        student: 'id, schoolId, name',  // Dexie index spec for your entities
      },
      authHeaders: () => ({ Authorization: `Bearer ${localStorage.getItem('token')}` }),
      channels: (injector) => {
        const auth = injector.get(AuthStore);   // your auth store
        return channelsFromGrants(auth.grants(), (g) => ({
          org: g.orgId,
          school: g.schoolId,
        }));
        // → ['org:abc/school:xyz', ...]
      },
    }),
  ],
};
```

---

## 3. Use sync data in a component

```typescript
// students.component.ts
import { Component } from '@angular/core';
import { syncCollection, injectSyncStatus } from '@maayo/angular';

@Component({
  selector: 'app-students',
  template: `
    <p>Status: {{ status() }}</p>
    @for (s of students(); track s.id) {
      <div>{{ s.name }}</div>
    }
  `,
})
export class StudentsComponent {
  readonly students = syncCollection<Student>('student');
  readonly status = injectSyncStatus();
}
```

`syncCollection` returns a `Signal<T[]>` that updates automatically as the local IndexedDB changes — no subscriptions, no manual refresh.

---

## 4. Enqueue a local write

```typescript
import { inject } from '@angular/core';
import { SYNC_ENGINE } from '@maayo/angular';
import { enqueue } from '@maayo/client';

// inside a component / service
const engine = inject(SYNC_ENGINE);

await enqueue(engine.db, {
  channel: 'org:abc/school:xyz',
  entityType: 'Student',
  entityId: '550e8400-e29b-41d4-a716-446655440000',
  op: 'CREATE',
  payload: { id: '550e...', name: 'Ada Lovelace', updatedAt: new Date().toISOString() },
  authorIdentityId: currentUserId,
});
// → queued in _outbox; synced to server on next push cycle
```

---

## 5. Add the Spring Boot server

```kotlin
// build.gradle.kts
implementation("dev.maayo:maayo-spring:0.1.0")
```

```yaml
# application.yml
maayo:
  enabled: true          # default — can omit
  default-limit: 500     # mutations per GET /sync/changes page
```

That's it. Two controllers are registered automatically:

```
POST /sync/mutations
GET  /sync/changes
```

For production, replace the default `PermitAllChannelAuthorizer`:

```kotlin
@Component
class MyChannelAuthorizer(private val authService: AuthService) : ChannelAuthorizer {
    override fun canPush(principal: Principal?, channel: String) =
        authService.hasWriteAccess(principal?.name, channel)

    override fun canPull(principal: Principal?, channel: String) =
        authService.hasReadAccess(principal?.name, channel)
}
```

---

## What happens at runtime

1. `provideSync` starts `SyncEngine` via `APP_INITIALIZER`.
2. Every 10 seconds (default): push queued outbox rows → pull deltas per channel.
3. Local IndexedDB tables update → signals in your components re-render automatically.
4. If the device goes offline, outbox rows accumulate locally and drain when connectivity returns.

---

## Next steps

- [Core Concepts](./concepts.md) — understand the outbox, channels, LWW, and cursors
- [Protocol Specification](./protocol.md) — implement a custom backend
- [`@maayo/client` API](./packages/client.md) — direct engine/outbox access
- [`@maayo/angular` API](./packages/angular.md) — full Angular API reference
- [`@maayo/spring` API](./packages/spring.md) — Spring Boot configuration reference
