package dev.maayo.spring

import org.springframework.boot.context.properties.ConfigurationProperties

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
)
