package dev.maayo.spring.jpa

import jakarta.persistence.*
import java.time.Instant

@Entity
@Table(
    name = "maayo_mutations",
    indexes = [
        Index(name = "idx_maayo_channel_received", columnList = "channel, receivedAt"),
        Index(name = "idx_maayo_maayo_id", columnList = "maayoId", unique = true),
    ],
)
class MaayoMutationRecord(
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    val id: Long? = null,

    /** ULID from the client — the idempotency key. */
    @Column(nullable = false, unique = true, length = 26)
    val maayoId: String,

    @Column(nullable = false)
    val channel: String,

    @Column(nullable = false)
    val entityType: String,

    @Column(nullable = false)
    val entityId: String,

    @Column(nullable = false, length = 10)
    val op: String,

    @Column(nullable = false, columnDefinition = "TEXT")
    val payload: String,

    @Column(nullable = false)
    val authorIdentityId: String,

    @Column(nullable = false)
    val deviceId: String,

    @Column(nullable = false)
    val clientTs: Instant,

    /** JSON-serialised list of parent ULID strings. */
    @Column(columnDefinition = "TEXT")
    val parentIds: String = "[]",

    @Column(nullable = false)
    val receivedAt: Instant = Instant.now(),
)
