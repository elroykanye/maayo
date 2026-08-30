package dev.maayo.spring.jpa

import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param
import java.time.Instant

interface MaayoMutationJpaRepository : JpaRepository<MaayoMutationRecord, Long> {

    fun existsByMaayoId(maayoId: String): Boolean

    /**
     * Finds mutations for a channel (including sub-channels) after the compound
     * ([since], [lastMutationId]) cursor, ordered oldest-first, up to [limit] rows.
     */
    @Query("""
        SELECT m FROM MaayoMutationRecord m
        WHERE (m.channel = :channel OR m.channel LIKE CONCAT(:channel, '/%'))
          AND (
            :since IS NULL
            OR m.receivedAt > :since
            OR (:lastMutationId IS NOT NULL AND m.receivedAt = :since AND m.maayoId > :lastMutationId)
          )
        ORDER BY m.receivedAt ASC, m.maayoId ASC
        LIMIT :limit
    """)
    fun findByChannelAndCursor(
        @Param("channel") channel: String,
        @Param("since") since: Instant?,
        @Param("lastMutationId") lastMutationId: String?,
        @Param("limit") limit: Int,
    ): List<MaayoMutationRecord>
}
