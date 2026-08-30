package dev.maayo.spring

import dev.maayo.spring.api.BatchMutationsRequest
import dev.maayo.spring.api.Mutation
import dev.maayo.spring.api.MutationController
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import java.time.Instant

class MutationControllerTest {
    @Test
    fun `concurrent duplicate recovery still saves unrelated rows`() {
        val raced = mutation("01HTEST0000000000000000021")
        val unrelated = mutation("01HTEST0000000000000000022")
        val repository = RacingRepository(raced.id)
        val controller = MutationController(repository, PermitAllChannelAuthorizer())

        val response = controller.push(BatchMutationsRequest(listOf(raced, unrelated)), null)

        assertEquals(setOf(raced.id, unrelated.id), response.accepted.map { it.id }.toSet())
        assertEquals(listOf(unrelated.id), repository.retryIds)
    }

    @Test
    fun `unrelated persistence failure remains visible`() {
        val failure = IllegalStateException("database offline")
        val repository = object : MaayoRepository {
            override fun existsById(id: String) = false
            override fun saveAll(mutations: List<Mutation>): List<SavedMutation> = throw failure
            override fun findChanges(channel: String, since: Instant?, limit: Int) = emptyList<SavedMutation>()
        }
        val controller = MutationController(repository, PermitAllChannelAuthorizer())

        val thrown = assertThrows(IllegalStateException::class.java) {
            controller.push(BatchMutationsRequest(listOf(mutation("01HTEST0000000000000000023"))), null)
        }

        assertEquals(failure, thrown)
    }

    private fun mutation(id: String) = Mutation(
        id = id,
        channel = "org:test",
        entityType = "Student",
        entityId = "student-$id",
        op = "CREATE",
        payload = "{}",
        authorIdentityId = "user-1",
        deviceId = "device-1",
        clientTs = "2026-01-01T00:00:00Z",
    )

    private class RacingRepository(private val racedId: String) : MaayoRepository {
        private val persisted = mutableSetOf<String>()
        private var saveCalls = 0
        var retryIds: List<String> = emptyList()
            private set

        override fun existsById(id: String) = id in persisted

        override fun saveAll(mutations: List<Mutation>): List<SavedMutation> {
            saveCalls++
            if (saveCalls == 1) {
                persisted += racedId
                throw IllegalStateException("unique constraint")
            }
            retryIds = mutations.map { it.id }
            persisted += retryIds
            return mutations.map { SavedMutation(it, Instant.parse("2026-08-30T12:00:00Z")) }
        }

        override fun findChanges(channel: String, since: Instant?, limit: Int) = emptyList<SavedMutation>()
    }
}
