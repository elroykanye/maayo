# @maayo/spring

Spring Boot 3 autoconfiguration for the Maayo sync protocol. Adds `POST /sync/mutations` and `GET /sync/changes` to any Spring Boot application with zero boilerplate.

## Add the dependency

```kotlin
// build.gradle.kts
implementation("dev.maayo:maayo-spring:0.1.0")
```

```xml
<!-- pom.xml -->
<dependency>
  <groupId>dev.maayo</groupId>
  <artifactId>maayo-spring</artifactId>
  <version>0.1.0</version>
</dependency>
```

Requires: Spring Boot 3.x, Java 17+. Spring Data JPA (and a database) is required for the built-in JPA repository.

---

## Configuration

```yaml
# application.yml
maayo:
  enabled: true          # set false to disable all Maayo endpoints
  default-limit: 500     # max mutations per GET /sync/changes page (1–2000)
```

| Property | Default | Description |
|----------|---------|-------------|
| `maayo.enabled` | `true` | Disable to stop both controllers from registering |
| `maayo.default-limit` | `500` | Default page size for `GET /sync/changes` |

---

## Auto-wired endpoints

### `POST /sync/mutations`

Accepts a batch of client mutations. Validates each mutation, checks idempotency, calls `ChannelAuthorizer.canPush`, persists new mutations, and returns an accepted/rejected breakdown.

**Request**: `BatchMutationsRequest` (see [protocol](../protocol.md))  
**Response**: `BatchMutationsResponse`

### `GET /sync/changes`

Returns paginated mutations for a channel. Calls `ChannelAuthorizer.canPull`, queries `MaayoRepository.findChanges` with a prefix match on the channel hierarchy, and returns a `ChangesResponse` with a cursor.

**Query params**: `channel` (required), `since` (ISO-8601, optional), `limit` (optional)

---

## `ChannelAuthorizer`

Implement this bean to enforce RBAC-based channel gating. The default (`PermitAllChannelAuthorizer`) allows everything — suitable for development only.

```kotlin
interface ChannelAuthorizer {
    fun canPush(principal: Principal?, channel: String): Boolean
    fun canPull(principal: Principal?, channel: String): Boolean
}
```

Register your implementation as a Spring bean and it will replace the default:

```kotlin
@Component
class MyChannelAuthorizer(private val authService: AuthService) : ChannelAuthorizer {

    override fun canPush(principal: Principal?, channel: String): Boolean =
        authService.hasWriteAccess(principal?.name ?: return false, channel)

    override fun canPull(principal: Principal?, channel: String): Boolean =
        authService.hasReadAccess(principal?.name ?: return false, channel)
}
```

---

## `MaayoRepository`

The persistence port. The default JPA implementation is registered automatically when Spring Data JPA is on the classpath. Provide your own bean to use a different store (e.g. MongoDB, R2DBC):

```kotlin
interface MaayoRepository {
    /** Returns true if a mutation with this ULID has already been accepted. */
    fun existsById(id: String): Boolean

    /** Persists new mutations and returns them with a server-assigned receivedAt. */
    fun saveAll(mutations: List<Mutation>): List<SavedMutation>

    /**
     * Returns mutations for [channel] and all sub-channels (prefix `channel/`),
     * received after [since], ordered by receivedAt ASC, capped at [limit].
     */
    fun findChanges(channel: String, since: Instant?, limit: Int): List<SavedMutation>
}
```

---

## JPA schema

The built-in JPA adapter creates a single table `maayo_mutation`:

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGINT (auto) | Surrogate PK |
| `maayo_id` | VARCHAR(26) | ULID — unique index |
| `channel` | VARCHAR(255) | Indexed with `received_at` |
| `entity_type` | VARCHAR(255) | |
| `entity_id` | VARCHAR(255) | |
| `op` | VARCHAR(10) | |
| `payload` | TEXT | |
| `author_identity_id` | VARCHAR(255) | |
| `device_id` | VARCHAR(255) | |
| `client_ts` | VARCHAR(30) | |
| `parent_ids` | TEXT | JSON array |
| `received_at` | TIMESTAMP | Server-assigned; indexed |

Schema is created by Spring/Hibernate DDL or Flyway. For production use Flyway:

```sql
-- V1__maayo_mutations.sql
CREATE TABLE maayo_mutation (
    id               BIGSERIAL PRIMARY KEY,
    maayo_id         VARCHAR(26)  NOT NULL UNIQUE,
    channel          VARCHAR(255) NOT NULL,
    entity_type      VARCHAR(255) NOT NULL,
    entity_id        VARCHAR(255) NOT NULL,
    op               VARCHAR(10)  NOT NULL,
    payload          TEXT         NOT NULL,
    author_identity_id VARCHAR(255) NOT NULL,
    device_id        VARCHAR(255) NOT NULL,
    client_ts        VARCHAR(30)  NOT NULL,
    parent_ids       TEXT         NOT NULL DEFAULT '[]',
    received_at      TIMESTAMP    NOT NULL
);

CREATE INDEX idx_maayo_channel_received ON maayo_mutation (channel, received_at);
```

---

## Testing

Use H2 in-memory for integration tests:

```yaml
# src/test/resources/application.yml
spring:
  datasource:
    url: jdbc:h2:mem:testdb;DB_CLOSE_DELAY=-1
    driver-class-name: org.h2.Driver
  jpa:
    hibernate:
      ddl-auto: create-drop
    database-platform: org.hibernate.dialect.H2Dialect
```

```kotlin
@SpringBootTest
@AutoConfigureMockMvc
class MyMaayoTest {
    @Autowired lateinit var mvc: MockMvc
    @Autowired lateinit var mapper: ObjectMapper

    @Test
    fun `push and pull round trip`() {
        // push
        mvc.post("/sync/mutations") {
            contentType = MediaType.APPLICATION_JSON
            content = mapper.writeValueAsString(BatchMutationsRequest(listOf(/* ... */)))
        }.andExpect { status { isOk() } }

        // pull
        val result = mvc.get("/sync/changes") {
            param("channel", "org:test")
        }.andExpect { status { isOk() } }.andReturn()

        val response = mapper.readValue(result.response.contentAsString, ChangesResponse::class.java)
        assertTrue(response.mutations.isNotEmpty())
    }
}
```
