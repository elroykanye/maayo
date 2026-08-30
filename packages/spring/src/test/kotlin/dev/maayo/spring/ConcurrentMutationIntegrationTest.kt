package dev.maayo.spring

import com.fasterxml.jackson.databind.ObjectMapper
import dev.maayo.spring.api.BatchMutationsRequest
import dev.maayo.spring.api.BatchMutationsResponse
import dev.maayo.spring.api.Mutation
import dev.maayo.spring.jpa.MaayoMutationJpaRepository
import dev.maayo.spring.test.TestApplication
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.mockito.ArgumentMatchers.anyString
import org.mockito.Mockito.doAnswer
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.http.MediaType
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.post
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

@SpringBootTest(classes = [TestApplication::class])
@AutoConfigureMockMvc
class ConcurrentMutationIntegrationTest {
    @Autowired lateinit var mvc: MockMvc
    @Autowired lateinit var mapper: ObjectMapper
    @Autowired lateinit var jpa: MaayoMutationJpaRepository
    @MockitoSpyBean lateinit var repository: MaayoRepository

    @Test
    fun `simultaneous duplicate HTTP requests preserve an unrelated row through the JPA unique constraint`() {
        val raced = mutation("01HTEST0000000000000000040")
        val unrelated = mutation("01HTEST0000000000000000041")
        val initialChecks = AtomicInteger()
        val bothRequestsChecked = CountDownLatch(2)
        doAnswer { invocation ->
            val id = invocation.getArgument<String>(0)
            if (id == raced.id && initialChecks.incrementAndGet() <= 2) {
                bothRequestsChecked.countDown()
                assertTrue(bothRequestsChecked.await(5, TimeUnit.SECONDS), "both requests must reach existsById")
                false
            } else {
                jpa.existsByMaayoId(id)
            }
        }.`when`(repository).existsById(anyString())

        val executor = Executors.newFixedThreadPool(2)
        try {
            val first = executor.submit<BatchMutationsResponse> {
                post(listOf(raced))
            }
            val second = executor.submit<BatchMutationsResponse> {
                post(listOf(raced, unrelated))
            }

            val firstResponse = first.get(10, TimeUnit.SECONDS)
            val secondResponse = second.get(10, TimeUnit.SECONDS)

            assertTrue(firstResponse.accepted.any { it.id == raced.id })
            assertEquals(setOf(raced.id, unrelated.id), secondResponse.accepted.map { it.id }.toSet())
            assertTrue(jpa.existsByMaayoId(raced.id))
            assertTrue(jpa.existsByMaayoId(unrelated.id))
        } finally {
            executor.shutdownNow()
        }
    }

    private fun post(mutations: List<Mutation>): BatchMutationsResponse {
        val result = mvc.post("/sync/mutations") {
            contentType = MediaType.APPLICATION_JSON
            content = mapper.writeValueAsString(BatchMutationsRequest(mutations))
        }.andExpect { status { isOk() } }.andReturn()
        return mapper.readValue(result.response.contentAsString, BatchMutationsResponse::class.java)
    }

    private fun mutation(id: String) = Mutation(
        id = id,
        channel = "org:concurrent",
        entityType = "Student",
        entityId = "student-$id",
        op = "CREATE",
        payload = "{}",
        authorIdentityId = "user-1",
        deviceId = "device-1",
        clientTs = "2026-08-30T12:00:00Z",
        parentIds = emptyList(),
    )
}
