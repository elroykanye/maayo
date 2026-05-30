package dev.maayo.spring

import org.springframework.boot.context.properties.ConfigurationProperties

@ConfigurationProperties(prefix = "maayo")
data class MaayoProperties(
    /** Set to false to disable all Maayo endpoints. */
    val enabled: Boolean = true,
    /** Maximum mutations returned per GET /sync/changes response. */
    val defaultLimit: Int = 500,
)
