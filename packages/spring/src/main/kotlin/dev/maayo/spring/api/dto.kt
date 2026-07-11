package dev.maayo.spring.api

data class Mutation(
    val id: String,
    val channel: String,
    val entityType: String,
    val entityId: String,
    val op: String,
    val payload: String,
    val authorIdentityId: String,
    val deviceId: String,
    val clientTs: String,
    val parentIds: List<String> = emptyList(),
)

data class BatchMutationsRequest(
    val mutations: List<Mutation>,
)

data class AcceptedMutation(val id: String, val receivedAt: String)
data class RejectedMutation(
    val id: String,
    /** Human-readable explanation, safe to surface in a client UI. */
    val reason: String,
    /** Optional machine-readable code — lets clients quarantine PERMANENT
     *  rejections immediately (see the client's permanentRejectCodes). */
    val code: String? = null,
)

data class BatchMutationsResponse(
    val accepted: List<AcceptedMutation>,
    val rejected: List<RejectedMutation>,
)

data class Cursor(
    val lastMutationId: String?,
    val lastReceivedAt: String?,
)

data class ChangesResponse(
    val channel: String,
    val mutations: List<Mutation>,
    val cursor: Cursor,
    val hasMore: Boolean,
)

data class EntitySchema(val entityType: String, val policy: String)

/** Response body of GET /sync/schema — the declared conflict policy per entity type. */
data class SchemaResponse(val entities: List<EntitySchema>)
