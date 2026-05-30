package dev.maayo.spring.jpa

import com.fasterxml.jackson.core.type.TypeReference
import com.fasterxml.jackson.databind.ObjectMapper
import dev.maayo.spring.MaayoRepository
import dev.maayo.spring.SavedMutation
import dev.maayo.spring.api.Mutation
import java.time.Instant

class JpaMaayoRepository(
    private val jpa: MaayoMutationJpaRepository,
    private val mapper: ObjectMapper,
) : MaayoRepository {

    override fun existsById(id: String): Boolean = jpa.existsByMaayoId(id)

    override fun saveAll(mutations: List<Mutation>): List<SavedMutation> {
        val now = Instant.now()
        val records = mutations.map { m ->
            MaayoMutationRecord(
                maayoId = m.id,
                channel = m.channel,
                entityType = m.entityType,
                entityId = m.entityId,
                op = m.op,
                payload = m.payload,
                authorIdentityId = m.authorIdentityId,
                deviceId = m.deviceId,
                clientTs = runCatching { Instant.parse(m.clientTs) }.getOrElse { now },
                parentIds = mapper.writeValueAsString(m.parentIds),
                receivedAt = now,
            )
        }
        return jpa.saveAll(records).map { it.toSaved() }
    }

    override fun findChanges(channel: String, since: Instant?, limit: Int): List<SavedMutation> =
        jpa.findByChannelAndSince(channel, since, limit).map { it.toSaved() }

    private val listType = object : TypeReference<List<String>>() {}

    private fun MaayoMutationRecord.toSaved() = SavedMutation(
        mutation = Mutation(
            id = maayoId,
            channel = channel,
            entityType = entityType,
            entityId = entityId,
            op = op,
            payload = payload,
            authorIdentityId = authorIdentityId,
            deviceId = deviceId,
            clientTs = clientTs.toString(),
            parentIds = runCatching { mapper.readValue(parentIds, listType) }.getOrElse { emptyList() },
        ),
        receivedAt = receivedAt,
    )
}
