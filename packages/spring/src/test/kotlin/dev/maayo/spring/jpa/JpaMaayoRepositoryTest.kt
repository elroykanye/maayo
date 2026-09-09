package dev.maayo.spring.jpa

import com.fasterxml.jackson.databind.ObjectMapper
import dev.maayo.spring.DuplicateMutationException
import dev.maayo.spring.api.Mutation
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.mockito.ArgumentMatchers.anyList
import org.mockito.Mockito.doThrow
import org.mockito.Mockito.mock
import java.sql.SQLException

class JpaMaayoRepositoryTest {
    @Test
    fun `translates a MySQL duplicate key to the typed conflict`() {
        val failure = RuntimeException(SQLException("Duplicate entry", "23000", 1062))
        val repository = repositoryThrowing(failure)

        assertThrows(DuplicateMutationException::class.java) {
            repository.saveAll(listOf(mutation()))
        }
    }

    @Test
    fun `does not translate a non-unique MySQL integrity violation`() {
        val failure = RuntimeException(SQLException("Foreign key violation", "23000", 1452))
        val repository = repositoryThrowing(failure)

        val thrown = assertThrows(RuntimeException::class.java) {
            repository.saveAll(listOf(mutation()))
        }

        assertEquals(failure, thrown)
    }

    private fun repositoryThrowing(failure: RuntimeException): JpaMaayoRepository {
        val jpa = mock(MaayoMutationJpaRepository::class.java)
        doThrow(failure).`when`(jpa).saveAllAndFlush(anyList())
        return JpaMaayoRepository(jpa, ObjectMapper())
    }

    private fun mutation() = Mutation(
        id = "01HTEST0000000000000000040",
        channel = "org:test",
        entityType = "Student",
        entityId = "student-40",
        op = "CREATE",
        payload = "{}",
        authorIdentityId = "user-1",
        deviceId = "device-1",
        clientTs = "2026-09-02T00:00:00Z",
    )
}
