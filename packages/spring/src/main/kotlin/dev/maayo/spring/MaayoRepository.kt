package dev.maayo.spring

import dev.maayo.spring.api.Mutation
import java.time.Instant

/**
 * Port for mutation persistence. Implement this bean (or let [dev.maayo.spring.jpa.MaayoJpaAutoConfiguration]
 * provide a default JPA implementation when Spring Data JPA is on the classpath).
 */
interface MaayoRepository {
    /** Returns true if a mutation with this ULID has already been accepted. */
    fun existsById(id: String): Boolean

    /** Persists a batch of new mutations and returns them with server-assigned [receivedAt]. */
    fun saveAll(mutations: List<Mutation>): List<SavedMutation>

    /**
     * Returns mutations for [channel] and all sub-channels (prefix match on channel + '/')
     * received after [since], ordered by receivedAt ASC, capped at [limit].
     */
    fun findChanges(channel: String, since: Instant?, limit: Int): List<SavedMutation>

    /**
     * Compound-cursor variant used to continue safely when multiple mutations
     * share [since]. Existing repository implementations remain source-compatible
     * through this default, while implementations with stable ordering should
     * override it and filter after ([since], [lastMutationId]).
     */
    fun findChanges(
        channel: String,
        since: Instant?,
        lastMutationId: String?,
        limit: Int,
    ): List<SavedMutation> = findChanges(channel, since, limit)
}

data class SavedMutation(
    val mutation: Mutation,
    val receivedAt: Instant,
)
