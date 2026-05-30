package dev.maayo.spring.jpa

import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param
import java.time.Instant

interface MaayoMutationJpaRepository : JpaRepository<MaayoMutationRecord, Long> {

    fun existsByMaayoId(maayoId: String): Boolean

    /**
     * Finds mutations for a channel (including sub-channels) received after [since],
     * ordered oldest-first, up to [limit] rows.
     */
    @Query("""
        SELECT m FROM MaayoMutationRecord m
        WHERE (m.channel = :channel OR m.channel LIKE CONCAT(:channel, '/%'))
          AND (:since IS NULL OR m.receivedAt > :since)
        ORDER BY m.receivedAt ASC
        LIMIT :limit
    """)
    fun findByChannelAndSince(
        @Param("channel") channel: String,
        @Param("since") since: Instant?,
        @Param("limit") limit: Int,
    ): List<MaayoMutationRecord>
}
