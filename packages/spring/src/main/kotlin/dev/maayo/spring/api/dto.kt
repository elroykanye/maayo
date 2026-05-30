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
data class RejectedMutation(val id: String, val reason: String)

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
