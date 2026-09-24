package dev.maayo.spring

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.MapperFeature
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.SerializationFeature
import com.fasterxml.jackson.databind.node.ObjectNode
import dev.maayo.spring.api.CheckpointMaterializedRow
import dev.maayo.spring.api.CheckpointMergeMetadata
import dev.maayo.spring.api.Cursor
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.Principal
import java.time.Instant
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

fun interface SnapshotTenantResolver {
    fun resolve(principal: Principal?, channel: String): String
}

data class SnapshotPackIdentity(
    val tenantId: String,
    val channel: String,
    val projectionKey: String,
    val projectionRevision: String,
    val schemaVersion: String,
    val throughCursor: Cursor,
)

data class SnapshotPackChunk(
    val digest: String,
    val rows: List<CheckpointMaterializedRow>,
    val mergeMetadata: List<CheckpointMergeMetadata>,
)

data class SnapshotPackChunkReference(
    val digest: String,
    val byteLength: Int,
    val rowCount: Int,
    val metadataCount: Int,
)

data class SnapshotPackIntegrity(val algorithm: String = "sha-256", val manifestDigest: String)

data class SnapshotPackManifest(
    val protocolVersion: Int = 1,
    val identity: SnapshotPackIdentity,
    val cacheKey: String,
    val generation: String,
    val createdAt: String,
    val expiresAt: String,
    val chunks: List<SnapshotPackChunkReference>,
    val integrity: SnapshotPackIntegrity,
    val deliveryToken: String,
)

class SnapshotPackService(
    private val provider: CheckpointProvider,
    objectMapper: ObjectMapper,
    signingKey: String,
    private val maxRowsPerChunk: Int,
    private val ttlSeconds: Long,
) {
    private val mapper = objectMapper
    private val canonical = objectMapper.copy()
        .enable(MapperFeature.SORT_PROPERTIES_ALPHABETICALLY)
        .enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS)
    private val key = signingKey.toByteArray(StandardCharsets.UTF_8)
    private val storedChunks = ConcurrentHashMap<String, StoredChunk>()

    init {
        require(signingKey.length >= 32) { "maayo.snapshot-signing-key must contain at least 32 characters" }
        require(maxRowsPerChunk > 0) { "maayo.snapshot-chunk-rows must be positive" }
        require(ttlSeconds > 0) { "maayo.snapshot-ttl must be positive" }
    }

    fun manifest(
        tenantId: String,
        channel: String,
        projection: CheckpointProjection,
    ): SnapshotPackManifest {
        require(tenantId.isNotBlank()) { "SnapshotTenantResolver returned a blank tenant" }
        val snapshot = provider.createCheckpoint(
            CheckpointRequest(
                channel = channel,
                projection = projection.projection,
                projectionKey = projection.projectionKey,
                projectionRevision = projection.projectionRevision,
            ),
        )
        val identity = SnapshotPackIdentity(
            tenantId,
            channel,
            projection.projectionKey,
            projection.projectionRevision,
            snapshot.schemaVersion,
            snapshot.throughCursor,
        )
        val metadata = snapshot.rows.filter { it.mergeMetadata.isNotEmpty() }.associateBy { it.entityType to it.entityId }
        val chunks = snapshot.rows.chunked(maxRowsPerChunk).ifEmpty { listOf(emptyList()) }.map { rows ->
            val wireRows = rows.map { it.toWireRow() }
            val wireMetadata = rows.mapNotNull { row -> metadata[row.entityType to row.entityId]?.let {
                CheckpointMergeMetadata(it.entityType, it.entityId, it.mergeMetadata)
            } }
            val content = mapOf("rows" to wireRows, "mergeMetadata" to wireMetadata)
            val bytes = canonical.writeValueAsBytes(content)
            SnapshotPackChunk(sha256(bytes), wireRows, wireMetadata) to bytes.size
        }
        val createdAt = Instant.now()
        val expiresAt = createdAt.plusSeconds(ttlSeconds)
        val cacheKey = sha256(canonical.writeValueAsBytes(identity))
        val references = chunks.map { (chunk, size) ->
            SnapshotPackChunkReference(chunk.digest, size, chunk.rows.size, chunk.mergeMetadata.size)
        }
        val core = mapOf(
            "protocolVersion" to 1,
            "identity" to identity,
            "cacheKey" to cacheKey,
            "createdAt" to createdAt.toString(),
            "expiresAt" to expiresAt.toString(),
            "chunks" to references,
        )
        val generation = sha256(canonical.writeValueAsBytes(core))
        val token = token(generation, expiresAt.epochSecond)
        chunks.forEach { (chunk, _) ->
            storedChunks[chunk.digest] = StoredChunk(identity, generation, expiresAt, chunk)
        }
        return SnapshotPackManifest(
            identity = identity,
            cacheKey = cacheKey,
            generation = generation,
            createdAt = createdAt.toString(),
            expiresAt = expiresAt.toString(),
            chunks = references,
            integrity = SnapshotPackIntegrity(manifestDigest = generation),
            deliveryToken = token,
        )
    }

    fun chunk(
        tenantId: String,
        channel: String,
        projectionKey: String,
        digest: String,
        deliveryToken: String,
    ): SnapshotPackChunk? {
        val stored = storedChunks[digest] ?: return null
        if (stored.expiresAt <= Instant.now()) {
            storedChunks.remove(digest, stored)
            return null
        }
        if (stored.identity.tenantId != tenantId || stored.identity.channel != channel
            || stored.identity.projectionKey != projectionKey) return null
        if (!MessageDigest.isEqual(
                token(stored.generation, stored.expiresAt.epochSecond).toByteArray(),
                deliveryToken.toByteArray(),
            )) return null
        return stored.chunk
    }

    private fun CheckpointRow.toWireRow(): CheckpointMaterializedRow {
        val payloadNode: JsonNode = when {
            tombstone -> mapper.createObjectNode().apply {
                put("id", entityId)
                put("deletedAt", deletedAt)
                put("tombstone", true)
            }
            payload != null -> mapper.readTree(payload).also { require(it is ObjectNode) }
            else -> throw IllegalArgumentException("CheckpointProvider live rows must contain payload")
        }
        return CheckpointMaterializedRow(entityType, entityId, payloadNode, tombstone, deletedAt)
    }

    private fun token(generation: String, expiresAt: Long): String {
        val body = "$generation.$expiresAt"
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        val signature = Base64.getUrlEncoder().withoutPadding().encodeToString(mac.doFinal(body.toByteArray()))
        return "$body.$signature"
    }

    private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(bytes).joinToString("") { "%02x".format(it) }

    private data class StoredChunk(
        val identity: SnapshotPackIdentity,
        val generation: String,
        val expiresAt: Instant,
        val chunk: SnapshotPackChunk,
    )
}
