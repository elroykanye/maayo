package dev.maayo.spring

import dev.maayo.spring.api.Cursor
import java.security.MessageDigest
import java.security.Principal

/**
 * Application-owned projection of the caller's authorized view.
 *
 * [projectionKey] must change whenever two callers can observe different rows,
 * or whenever a caller's effective projection changes. It is included in the
 * checkpoint integrity material so private cache validators cannot collide.
 */
data class CheckpointProjection(
    val projection: String,
    val projectionKey: String,
    val projectionRevision: String,
)

fun interface CheckpointProjectionResolver {
    fun resolve(principal: Principal?, channel: String, projection: String): CheckpointProjection
}

/**
 * Safe default for identity-scoped projections. Applications whose access
 * rules depend on roles, grants, or policy revisions should replace this bean
 * and include those inputs in the key.
 */
class DefaultCheckpointProjectionResolver : CheckpointProjectionResolver {
    override fun resolve(principal: Principal?, channel: String, projection: String): CheckpointProjection {
        val identity = principal?.name ?: "anonymous"
        val material = listOf(identity, channel, projection).joinToString("\u0000")
        val key = MessageDigest.getInstance("SHA-256")
            .digest(material.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        return CheckpointProjection(
            projection = projection,
            projectionKey = key,
            projectionRevision = "identity-v1",
        )
    }
}

data class CheckpointRequest(
    val channel: String,
    val projection: String,
    val projectionKey: String,
    val projectionRevision: String,
    /** When present, the provider must materialize exactly this compound cursor. */
    val throughCursor: Cursor? = null,
)

data class CheckpointReplayRequest(
    val channel: String,
    val projection: String,
    val projectionKey: String,
    val projectionRevision: String,
    /** Null means a caller is attempting replay from the beginning of the log. */
    val afterCursor: Cursor?,
)

data class CheckpointRow(
    val entityType: String,
    val entityId: String,
    /** Serialized entity JSON. Null for a deterministic tombstone. */
    val payload: String?,
    val tombstone: Boolean = false,
    val deletedAt: String? = null,
    /** For LWW rows include policy=LWW, clientTs, deviceId, and mutationId so
     * clients retain deterministic tie-break state after bounded audit eviction. */
    val mergeMetadata: Map<String, String> = emptyMap(),
)

data class CheckpointSnapshot(
    val schemaVersion: String,
    /** High-water mark captured in the same consistent view as [rows]. */
    val throughCursor: Cursor,
    val rows: List<CheckpointRow>,
    val mergeMetadata: Map<String, String> = emptyMap(),
)

sealed interface RetainedReplay {
    data class Available(val mutations: List<SavedMutation>) : RetainedReplay

    /** [retainedLogFloor] is the oldest compound cursor from which replay remains complete. */
    data class CheckpointRequired(val retainedLogFloor: Cursor) : RetainedReplay
}

/**
 * Checkpoint and archival safety seam.
 *
 * [createCheckpoint] must read rows and choose throughCursor from one consistent
 * database view. Implementations that archive mutations must also override
 * [readRetainedChanges] and perform their retained-floor check and [load] while
 * holding the same transaction/lease used by archival. That makes either the
 * complete tail or [RetainedReplay.CheckpointRequired] observable, never a gap.
 */
interface CheckpointProvider {
    fun createCheckpoint(request: CheckpointRequest): CheckpointSnapshot

    fun readRetainedChanges(
        request: CheckpointReplayRequest,
        load: () -> List<SavedMutation>,
    ): RetainedReplay = RetainedReplay.Available(load())
}
