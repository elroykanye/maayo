package dev.maayo.spring.api

import com.fasterxml.jackson.databind.MapperFeature
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.SerializationFeature
import com.fasterxml.jackson.databind.node.ObjectNode
import dev.maayo.spring.ChannelAuthorizer
import dev.maayo.spring.CheckpointProjectionResolver
import dev.maayo.spring.CheckpointProvider
import dev.maayo.spring.CheckpointRequest
import dev.maayo.spring.CheckpointRow
import com.aayushatharva.brotli4j.Brotli4jLoader
import com.aayushatharva.brotli4j.encoder.Encoder
import org.springframework.http.CacheControl
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestHeader
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.server.ResponseStatusException
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.security.Principal
import java.time.Instant
import java.util.Base64
import java.util.zip.GZIPOutputStream

@RestController
@RequestMapping("/sync")
class CheckpointController(
    private val provider: CheckpointProvider,
    private val authorizer: ChannelAuthorizer,
    private val projectionResolver: CheckpointProjectionResolver,
    objectMapper: ObjectMapper,
) {
    private val jsonMapper = objectMapper
    private val canonicalMapper = objectMapper.copy()
        .enable(MapperFeature.SORT_PROPERTIES_ALPHABETICALLY)
        .enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS)

    @GetMapping("/checkpoint", produces = [MediaType.APPLICATION_JSON_VALUE])
    fun checkpoint(
        @RequestParam channel: String,
        @RequestParam(defaultValue = "default") projection: String,
        @RequestParam(required = false) throughReceivedAt: String?,
        @RequestParam(required = false) throughMutationId: String?,
        @RequestHeader(name = HttpHeaders.IF_NONE_MATCH, required = false) ifNoneMatch: String?,
        @RequestHeader(name = HttpHeaders.ACCEPT_ENCODING, required = false) acceptEncoding: String?,
        principal: Principal?,
    ): ResponseEntity<ByteArray> {
        if (!authorizer.canPull(principal, channel)) {
            throw ResponseStatusException(HttpStatus.FORBIDDEN, "unauthorized for channel $channel")
        }
        if (projection.isBlank()) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "projection must not be blank")
        }
        val requestedCursor = parseCursorPair(throughReceivedAt, throughMutationId)
        val resolved = projectionResolver.resolve(principal, channel, projection)
        require(resolved.projection == projection) {
            "CheckpointProjectionResolver changed the requested projection"
        }
        require(resolved.projectionKey.isNotBlank()) {
            "CheckpointProjectionResolver returned a blank projection key"
        }

        val request = CheckpointRequest(
            channel,
            projection,
            resolved.projectionKey,
            resolved.projectionRevision,
            requestedCursor,
        )
        val snapshot = provider.createCheckpoint(request)
        validateSnapshot(snapshot.schemaVersion, snapshot.throughCursor, snapshot.rows, requestedCursor)
        val rows = snapshot.rows.map { it.toWireRow() }
        val mergeMetadata = snapshot.rows
            .filter { it.mergeMetadata.isNotEmpty() }
            .map {
                CheckpointMergeMetadata(
                    entityType = it.entityType,
                    entityId = it.entityId,
                    value = it.mergeMetadata,
                )
            }

        val content = CheckpointContent(
            protocolVersion = 1,
            schemaVersion = snapshot.schemaVersion,
            channel = channel,
            projection = projection,
            projectionKey = resolved.projectionKey,
            projectionRevision = resolved.projectionRevision,
            throughCursor = snapshot.throughCursor,
            rows = rows,
            mergeMetadata = mergeMetadata,
        )
        val canonicalBytes = canonicalMapper.writeValueAsBytes(content)
        val digest = MessageDigest.getInstance("SHA-256").digest(canonicalBytes)
        val checksum = digest.joinToString("") { "%02x".format(it) }
        val etag = "W/\"sha256-$checksum\""
        val headers = responseHeaders(etag, digest)

        if (matches(ifNoneMatch, etag)) {
            return ResponseEntity.status(HttpStatus.NOT_MODIFIED).headers(headers).build()
        }

        val envelope = CheckpointEnvelope(
            protocolVersion = content.protocolVersion,
            schemaVersion = content.schemaVersion,
            channel = content.channel,
            projection = content.projection,
            projectionKey = content.projectionKey,
            projectionRevision = content.projectionRevision,
            throughCursor = content.throughCursor,
            rows = content.rows,
            mergeMetadata = content.mergeMetadata,
            integrity = CheckpointIntegrity("sha-256", checksum, "rows-and-merge-metadata"),
        )
        val identityBody = canonicalMapper.writeValueAsBytes(envelope)
        val encoding = preferredEncoding(acceptEncoding)
        val body = when (encoding) {
            "br" -> brotli(identityBody)
            "gzip" -> gzip(identityBody)
            else -> identityBody
        }
        if (encoding != null) headers.set(HttpHeaders.CONTENT_ENCODING, encoding)
        return ResponseEntity.ok().headers(headers).body(body)
    }

    private fun parseCursorPair(receivedAt: String?, mutationId: String?): Cursor? {
        val hasReceivedAt = !receivedAt.isNullOrBlank()
        val hasMutationId = !mutationId.isNullOrBlank()
        if (hasReceivedAt != hasMutationId) {
            throw ResponseStatusException(
                HttpStatus.BAD_REQUEST,
                "throughReceivedAt and throughMutationId must be provided together",
            )
        }
        if (!hasReceivedAt) return null
        try {
            Instant.parse(receivedAt)
        } catch (_: RuntimeException) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "throughReceivedAt must be a valid ISO-8601 timestamp")
        }
        return Cursor(mutationId, receivedAt)
    }

    private fun validateSnapshot(
        schemaVersion: String,
        throughCursor: Cursor,
        rows: List<CheckpointRow>,
        requestedCursor: Cursor?,
    ) {
        require(schemaVersion.isNotBlank()) { "CheckpointProvider returned a blank schemaVersion" }
        val hasReceivedAt = !throughCursor.lastReceivedAt.isNullOrBlank()
        val hasMutationId = !throughCursor.lastMutationId.isNullOrBlank()
        require(hasReceivedAt == hasMutationId) { "CheckpointProvider returned an incomplete throughCursor" }
        throughCursor.lastReceivedAt?.let { Instant.parse(it) }
        require(requestedCursor == null || requestedCursor == throughCursor) {
            "CheckpointProvider did not materialize the requested throughCursor"
        }
        require(rows.distinctBy { it.entityType to it.entityId }.size == rows.size) {
            "CheckpointProvider returned duplicate entity rows"
        }
        rows.forEach { row ->
            require(row.entityType.isNotBlank() && row.entityId.isNotBlank()) {
                "CheckpointProvider returned a row with a blank entity identity"
            }
            require(!row.tombstone || row.payload == null) {
                "CheckpointProvider tombstones must not contain a live payload"
            }
            require(!row.tombstone || !row.deletedAt.isNullOrBlank()) {
                "CheckpointProvider tombstones must include deletedAt"
            }
        }
    }

    private fun CheckpointRow.toWireRow(): CheckpointMaterializedRow {
        val payloadNode = when {
            tombstone -> jsonMapper.createObjectNode().apply {
                put("id", entityId)
                put("deletedAt", deletedAt)
                put("tombstone", true)
            }
            payload != null -> jsonMapper.readTree(payload).also {
                require(it is ObjectNode) {
                    "CheckpointProvider live payloads must be JSON objects"
                }
            }
            else -> throw IllegalArgumentException("CheckpointProvider live rows must contain payload")
        }
        return CheckpointMaterializedRow(
            entityType = entityType,
            entityId = entityId,
            payload = payloadNode,
            tombstone = tombstone,
            deletedAt = deletedAt,
        )
    }

    private fun responseHeaders(etag: String, digest: ByteArray) = HttpHeaders().apply {
        contentType = MediaType.APPLICATION_JSON
        cacheControl = CacheControl.noCache().cachePrivate().headerValue
        set(HttpHeaders.ETAG, etag)
        set("Digest", "sha-256=:${Base64.getEncoder().encodeToString(digest)}:")
        vary = listOf(HttpHeaders.ACCEPT_ENCODING, HttpHeaders.AUTHORIZATION, HttpHeaders.COOKIE)
    }

    private fun matches(ifNoneMatch: String?, etag: String): Boolean =
        ifNoneMatch?.split(',')?.any { candidate -> candidate.trim() == "*" || candidate.trim() == etag } == true

    private fun preferredEncoding(header: String?): String? {
        val quality = header.orEmpty().split(',').mapNotNull { token ->
            val parts = token.trim().split(';')
            val name = parts.firstOrNull()?.lowercase()?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            val q = parts.drop(1).firstNotNullOfOrNull { parameter ->
                parameter.trim().takeIf { it.startsWith("q=", ignoreCase = true) }
                    ?.substringAfter('=')?.toDoubleOrNull()
            } ?: 1.0
            name to q
        }.toMap()
        val brotli = quality["br"] ?: 0.0
        val gzip = quality["gzip"] ?: 0.0
        return when {
            brotli > 0 && brotli >= gzip -> "br"
            gzip > 0 -> "gzip"
            else -> null
        }
    }

    private fun gzip(bytes: ByteArray): ByteArray = ByteArrayOutputStream().use { output ->
        GZIPOutputStream(output).use { it.write(bytes) }
        output.toByteArray()
    }

    private fun brotli(bytes: ByteArray): ByteArray {
        Brotli4jLoader.ensureAvailability()
        return Encoder.compress(bytes)
    }
}

private data class CheckpointContent(
    val protocolVersion: Int,
    val schemaVersion: String,
    val channel: String,
    val projection: String,
    val projectionKey: String,
    val projectionRevision: String,
    val throughCursor: Cursor,
    val rows: List<CheckpointMaterializedRow>,
    val mergeMetadata: List<CheckpointMergeMetadata>,
)

data class CheckpointIntegrity(
    val algorithm: String,
    /** Lowercase hexadecimal digest of the canonical checkpoint content, excluding this integrity object. */
    val checksum: String,
    val scope: String,
)

data class CheckpointEnvelope(
    val protocolVersion: Int,
    val schemaVersion: String,
    val channel: String,
    val projection: String,
    val projectionKey: String,
    val projectionRevision: String,
    val throughCursor: Cursor,
    val rows: List<CheckpointMaterializedRow>,
    val mergeMetadata: List<CheckpointMergeMetadata>,
    val integrity: CheckpointIntegrity,
)

data class CheckpointMaterializedRow(
    val entityType: String,
    val entityId: String,
    val payload: JsonNode,
    val tombstone: Boolean = false,
    val deletedAt: String? = null,
)

data class CheckpointMergeMetadata(
    val entityType: String,
    val entityId: String,
    val value: Map<String, String>,
)
