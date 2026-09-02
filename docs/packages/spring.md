# @maayo/spring

Spring Boot 3 server adapter for the Maayo offline-first sync protocol. Adds `POST /sync/mutations` and `GET /sync/changes` to any Spring Boot application.

**No specific database is required.** The integration point is the `MaayoRepository` interface — implement it for whatever store your application uses (SQL via JPA, MongoDB, DynamoDB, plain JDBC, R2DBC, etc.). A JPA default is auto-configured if Spring Data JPA is already on your classpath.

## Add the dependency

```kotlin
implementation("dev.maayo:maayo-spring:0.3.1")
```

Requires Spring Boot 3.x, Java 17+.

---

## Setup — three paths

### Path 1: already using Spring Data JPA (zero config)

Add the dependency. A `maayo_mutation` table is created automatically via Hibernate DDL and the two controllers register. Nothing else needed.

### Path 2: bring your own SQL store (plain JDBC, JOOQ, R2DBC, …)

```kotlin
@Component
class JdbcMaayoRepository(private val jdbc: JdbcTemplate) : MaayoRepository {

    override fun existsById(id: String): Boolean =
        jdbc.queryForObject(
            "SELECT COUNT(*) FROM maayo_mutation WHERE maayo_id = ?", Int::class.java, id
        )!! > 0

    override fun saveAll(mutations: List<Mutation>): List<SavedMutation> {
        val now = Instant.now()
        mutations.forEach { m ->
            jdbc.update(
                "INSERT INTO maayo_mutation (maayo_id, channel, entity_type, entity_id, op, payload, author_identity_id, device_id, client_ts, received_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                m.id, m.channel, m.entityType, m.entityId, m.op, m.payload,
                m.authorIdentityId, m.deviceId, m.clientTs, now
            )
        }
        return mutations.map { SavedMutation(it, now) }
    }

    override fun findChanges(channel: String, since: Instant?, limit: Int): List<SavedMutation> {
        val sql = buildString {
            append("SELECT * FROM maayo_mutation WHERE (channel = ? OR channel LIKE ?)")
            if (since != null) append(" AND received_at > ?")
            append(" ORDER BY received_at, maayo_id LIMIT ?")
        }
        val args = buildList {
            add(channel); add("$channel/%")
            if (since != null) add(since)
            add(limit)
        }
        return jdbc.query(sql, args.toTypedArray()) { rs, _ -> rs.toSaved() }
    }

    override fun findChanges(
        channel: String,
        since: Instant?,
        lastMutationId: String?,
        limit: Int,
    ): List<SavedMutation> {
        if (since == null || lastMutationId == null) return findChanges(channel, since, limit)
        val sql = """
            SELECT * FROM maayo_mutation
            WHERE (channel = ? OR channel LIKE ?)
              AND (received_at > ? OR (received_at = ? AND maayo_id > ?))
            ORDER BY received_at, maayo_id
            LIMIT ?
        """.trimIndent()
        return jdbc.query(
            sql,
            arrayOf(channel, "$channel/%", since, since, lastMutationId, limit),
        ) { rs, _ -> rs.toSaved() }
    }
}
```

### Path 3: document / NoSQL store

```kotlin
@Component
class MongoMaayoRepository(private val mongo: MongoTemplate) : MaayoRepository {

    override fun existsById(id: String): Boolean =
        mongo.exists(Query(Criteria.where("maayoId").`is`(id)), MaayoDocument::class.java)

    override fun saveAll(mutations: List<Mutation>): List<SavedMutation> {
        val now = Instant.now()
        return mutations.map { m ->
            mongo.save(m.toDocument(now))
            SavedMutation(m, now)
        }
    }

    override fun findChanges(channel: String, since: Instant?, limit: Int): List<SavedMutation> {
        // Channel hierarchy: exact match OR starts with "channel/"
        val channelCriteria = Criteria().orOperator(
            Criteria.where("channel").`is`(channel),
            Criteria.where("channel").regex("^${Regex.escape(channel)}/"),
        )
        val criteria = if (since != null)
            channelCriteria.and("receivedAt").gt(since)
        else
            channelCriteria
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
        val channelCriteria = Criteria().orOperator(
            Criteria.where("channel").`is`(channel),
            Criteria.where("channel").regex("^${Regex.escape(channel)}/"),
        )
        val cursorCriteria = Criteria().orOperator(
            Criteria.where("receivedAt").gt(since),
            Criteria().andOperator(
                Criteria.where("receivedAt").`is`(since),
                Criteria.where("maayoId").gt(lastMutationId),
            ),
        )
        val query = Query(Criteria().andOperator(channelCriteria, cursorCriteria))
            .with(Sort.by("receivedAt", "maayoId"))
            .limit(limit)
        return mongo.find(query, MaayoDocument::class.java).map { it.toSaved() }
    }
}
```

---

## `MaayoRepository` interface

```kotlin
interface MaayoRepository {
    /** True if a mutation with this ULID has already been accepted (idempotency check). */
    fun existsById(id: String): Boolean

    /** Persists new mutations and returns them with a server-assigned receivedAt timestamp. */
    fun saveAll(mutations: List<Mutation>): List<SavedMutation>

    /**
     * Returns mutations for [channel] and all sub-channels (i.e. channel == x OR channel starts with x/)
     * received after [since], ordered by receivedAt ASC, capped at [limit].
     */
    fun findChanges(channel: String, since: Instant?, limit: Int): List<SavedMutation>

    /** Continue strictly after the compound (receivedAt, mutation id) cursor. */
    fun findChanges(
        channel: String,
        since: Instant?,
        lastMutationId: String?,
        limit: Int,
    ): List<SavedMutation>
}

data class SavedMutation(val mutation: Mutation, val receivedAt: Instant)
```

Register any implementation as a Spring bean. Once a `MaayoRepository` bean is present, the controllers register automatically.
The four-argument method has a source-compatible default, but that default throws when a compound
continuation is requested. Custom repositories must override it with ordering and filtering by
`(receivedAt, mutation.id)` before serving continuation pages.

`saveAll` implementations should throw `DuplicateMutationException` only for a mutation-ID unique
constraint race. The controller recovers that typed conflict; unrelated persistence failures remain visible.

---

## `ChannelAuthorizer`

Controls which principals can push to or pull from a given channel. The default (`PermitAllChannelAuthorizer`) allows everything — replace it in production.

```kotlin
interface ChannelAuthorizer {
    fun canPush(principal: Principal?, channel: String): Boolean
    fun canPull(principal: Principal?, channel: String): Boolean
}

@Component
class GrantBasedAuthorizer(private val grants: GrantService) : ChannelAuthorizer {
    override fun canPush(principal: Principal?, channel: String) =
        grants.hasWrite(principal?.name, channel)
    override fun canPull(principal: Principal?, channel: String) =
        grants.hasRead(principal?.name, channel)
}
```

---

## Configuration

```yaml
maayo:
  enabled: true          # false to disable endpoints without removing the dependency
  default-limit: 500     # mutations per GET /sync/changes page (max 2000)
```

Both properties have defaults — zero YAML is needed for the common case.

---

## JPA schema (when using the built-in JPA adapter)

For production, manage the table with Flyway or Liquibase rather than relying on `ddl-auto`:

```sql
CREATE TABLE maayo_mutation (
    id                 BIGSERIAL    PRIMARY KEY,
    maayo_id           VARCHAR(26)  NOT NULL UNIQUE,
    channel            VARCHAR(255) NOT NULL,
    entity_type        VARCHAR(255) NOT NULL,
    entity_id          VARCHAR(255) NOT NULL,
    op                 VARCHAR(10)  NOT NULL,
    payload            TEXT         NOT NULL,
    author_identity_id VARCHAR(255) NOT NULL,
    device_id          VARCHAR(255) NOT NULL,
    client_ts          VARCHAR(30)  NOT NULL,
    parent_ids         TEXT         NOT NULL DEFAULT '[]',
    received_at        TIMESTAMP    NOT NULL
);

CREATE INDEX idx_maayo_channel_received_id ON maayo_mutation (channel, received_at, maayo_id);
```

This schema is compatible with any SQL database (Postgres, MySQL, SQLite, H2).

---

## Testing

```kotlin
@SpringBootTest
@AutoConfigureMockMvc
class SyncTest {
    @Autowired lateinit var mvc: MockMvc
    @Autowired lateinit var mapper: ObjectMapper

    @Test
    fun `push and pull round trip`() {
        val id = "01HTEST0000000000000000001"
        mvc.post("/sync/mutations") {
            contentType = MediaType.APPLICATION_JSON
            content = mapper.writeValueAsString(
                BatchMutationsRequest(listOf(
                    Mutation(id, "org:test", "Student", "stu-1", "CREATE",
                        "{}", "user-1", "device-1", "2026-01-01T00:00:00Z")
                ))
            )
        }.andExpect { status { isOk() } }

        val result = mvc.get("/sync/changes") {
            param("channel", "org:test")
        }.andExpect { status { isOk() } }.andReturn()

        val resp = mapper.readValue(result.response.contentAsString, ChangesResponse::class.java)
        assertTrue(resp.mutations.any { it.id == id })
    }
}
```

Use H2 for fast in-memory tests:

```yaml
# src/test/resources/application.yml
spring:
  datasource:
    url: jdbc:h2:mem:testdb;DB_CLOSE_DELAY=-1
  jpa:
    hibernate.ddl-auto: create-drop
```

---

## Declared conflict policies (`GET /sync/schema`)

Declare each entity type's conflict policy and the starter serves the optional
schema endpoint, so policy-aware clients (`@maayo/client`'s `policyApply`)
merge with the same semantics your appliers enforce:

```yaml
maayo:
  policies:
    Student: LWW
    Identity: FIELD_LWW
    Payment: APPEND_ONLY
    Enrollment: OR_SET
    Grade: MANUAL
```

An empty map serves an empty list — clients treat that as "everything is LWW".
Rejections can also carry a machine-readable `code` (see `RejectedMutation`) so
clients quarantine permanent failures immediately instead of retrying them.
