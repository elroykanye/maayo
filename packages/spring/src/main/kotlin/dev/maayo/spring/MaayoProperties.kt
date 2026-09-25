package dev.maayo.spring

import org.springframework.boot.context.properties.ConfigurationProperties
import java.time.Duration

@ConfigurationProperties(prefix = "maayo")
data class MaayoProperties(
    /** Set to false to disable all Maayo endpoints. */
    val enabled: Boolean = true,
    /** Maximum mutations returned per GET /sync/changes response. */
    val defaultLimit: Int = 500,
    /**
     * Declared conflict policy per entity type, served by GET /sync/schema so a
     * policy-aware client merges with the SAME semantics this server applies.
     * Values: LWW | FIELD_LWW | APPEND_ONLY | OR_SET | MANUAL. Example:
     * `maayo.policies.Student=LWW`, `maayo.policies.Payment=APPEND_ONLY`.
     * The endpoint is omitted while this map is empty.
     */
    val policies: Map<String, String> = emptyMap(),
    /** HMAC key for short-lived snapshot-pack chunk delivery tokens. */
    val snapshotSigningKey: String? = null,
    /** Maximum materialized rows per immutable snapshot chunk. */
    val snapshotChunkRows: Int = 1_000,
    /** Validity window for a generated snapshot manifest and its delivery token. */
    val snapshotTtl: Duration = Duration.ofMinutes(5),
)
