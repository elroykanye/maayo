package dev.maayo.spring

import dev.maayo.spring.api.ChangesController
import dev.maayo.spring.api.Mutation
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import java.time.Instant

class ChangesControllerTest {
    @Test
    fun `legacy repository fails explicitly for a compound continuation`() {
        val repository = object : MaayoRepository {
            override fun existsById(id: String) = false
            override fun saveAll(mutations: List<Mutation>) = emptyList<SavedMutation>()
            override fun findChanges(channel: String, since: Instant?, limit: Int) = emptyList<SavedMutation>()
        }
        val controller = ChangesController(repository, PermitAllChannelAuthorizer(), MaayoProperties())

        assertThrows(UnsupportedOperationException::class.java) {
            controller.pull(
                channel = "org:test",
                since = "2026-08-30T12:00:00Z",
                lastMutationId = "01HTEST0000000000000000099",
                limit = 1,
                principal = null,
            )
        }
    }
}
