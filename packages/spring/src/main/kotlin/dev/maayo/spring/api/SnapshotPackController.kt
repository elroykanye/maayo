package dev.maayo.spring.api

import dev.maayo.spring.ChannelAuthorizer
import dev.maayo.spring.CheckpointProjectionResolver
import dev.maayo.spring.SnapshotPackService
import dev.maayo.spring.SnapshotTenantResolver
import org.springframework.http.CacheControl
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.server.ResponseStatusException
import java.security.Principal
import java.time.Duration

@RestController
@RequestMapping("/sync/snapshot-packs")
class SnapshotPackController(
    private val service: SnapshotPackService,
    private val authorizer: ChannelAuthorizer,
    private val projectionResolver: CheckpointProjectionResolver,
    private val tenantResolver: SnapshotTenantResolver,
) {
    @GetMapping("/manifest")
    fun manifest(
        @RequestParam channel: String,
        @RequestParam(defaultValue = "default") projection: String,
        principal: Principal?,
    ): ResponseEntity<Any> {
        authorize(principal, channel)
        val resolved = projectionResolver.resolve(principal, channel, projection)
        val tenantId = tenantResolver.resolve(principal, channel)
        val manifest = service.manifest(tenantId, channel, resolved)
        return ResponseEntity.ok()
            .cacheControl(CacheControl.noCache().cachePrivate())
            .eTag("\"snapshot-pack-${manifest.generation}\"")
            .body(manifest)
    }

    @GetMapping("/chunks/{digest}")
    fun chunk(
        @PathVariable digest: String,
        @RequestParam channel: String,
        @RequestParam(defaultValue = "default") projection: String,
        @RequestParam token: String,
        principal: Principal?,
    ): ResponseEntity<Any> {
        authorize(principal, channel)
        if (!digest.matches(Regex("^[a-f0-9]{64}$"))) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "invalid snapshot chunk digest")
        }
        val resolved = projectionResolver.resolve(principal, channel, projection)
        val tenantId = tenantResolver.resolve(principal, channel)
        val chunk = service.chunk(tenantId, channel, resolved.projectionKey, digest, token)
            ?: throw ResponseStatusException(HttpStatus.NOT_FOUND, "snapshot chunk unavailable")
        return ResponseEntity.ok()
            .cacheControl(CacheControl.maxAge(Duration.ofDays(365)).cachePrivate().immutable())
            .header("X-Content-Type-Options", "nosniff")
            .body(chunk)
    }

    private fun authorize(principal: Principal?, channel: String) {
        if (!authorizer.canPull(principal, channel)) {
            throw ResponseStatusException(HttpStatus.FORBIDDEN, "unauthorized for channel $channel")
        }
    }
}
