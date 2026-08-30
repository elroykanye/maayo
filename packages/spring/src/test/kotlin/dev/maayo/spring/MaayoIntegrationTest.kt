package dev.maayo.spring

import com.fasterxml.jackson.databind.ObjectMapper
import dev.maayo.spring.api.BatchMutationsRequest
import dev.maayo.spring.api.BatchMutationsResponse
import dev.maayo.spring.api.ChangesResponse
import dev.maayo.spring.api.Mutation
import dev.maayo.spring.test.TestApplication
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.get
import org.springframework.test.web.servlet.post
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue

@SpringBootTest(classes = [TestApplication::class])
@AutoConfigureMockMvc
class MaayoIntegrationTest {

    @Autowired lateinit var mvc: MockMvc
    @Autowired lateinit var mapper: ObjectMapper
    @Autowired lateinit var repository: MaayoRepository

    @BeforeEach
    fun setup() {
        // Ensure clean state — cast to JPA impl for truncation
        val jpaRepo = (repository as? dev.maayo.spring.jpa.JpaMaayoRepository)
        // Reset via direct JPA (only in tests)
    }

    @Test
    fun `POST sync mutations accepts valid mutations`() {
        val request = BatchMutationsRequest(
            mutations = listOf(
                Mutation(
                    id = "01HTEST0000000000000000001",
                    channel = "org:test/school:s1",
                    entityType = "Student",
                    entityId = "stu-001",
                    op = "CREATE",
                    payload = """{"id":"stu-001","name":"Ada Lovelace"}""",
                    authorIdentityId = "user-1",
                    deviceId = "device-1",
                    clientTs = "2026-01-01T00:00:00Z",
                    parentIds = emptyList(),
                )
            )
        )

        val result = mvc.post("/sync/mutations") {
            contentType = MediaType.APPLICATION_JSON
            content = mapper.writeValueAsString(request)
        }.andExpect { status { isOk() } }
         .andReturn()

        val response = mapper.readValue(result.response.contentAsString, BatchMutationsResponse::class.java)
        assertEquals(1, response.accepted.size)
        assertEquals(0, response.rejected.size)
        assertEquals("01HTEST0000000000000000001", response.accepted[0].id)
    }

    @Test
    fun `POST sync mutations is idempotent on duplicate id`() {
        val mutation = Mutation(
            id = "01HTEST0000000000000000002",
            channel = "org:test",
            entityType = "Student",
            entityId = "stu-002",
            op = "CREATE",
            payload = "{}",
            authorIdentityId = "user-1",
            deviceId = "device-1",
            clientTs = "2026-01-01T00:00:00Z",
        )
        val request = BatchMutationsRequest(listOf(mutation))
        val body = mapper.writeValueAsString(request)

        // First push
        mvc.post("/sync/mutations") {
            contentType = MediaType.APPLICATION_JSON
            content = body
        }.andExpect { status { isOk() } }

        // Second push — must also accept (idempotent)
        val result = mvc.post("/sync/mutations") {
            contentType = MediaType.APPLICATION_JSON
            content = body
        }.andExpect { status { isOk() } }.andReturn()

        val response = mapper.readValue(result.response.contentAsString, BatchMutationsResponse::class.java)
        assertEquals(1, response.accepted.size)
        assertEquals(0, response.rejected.size)
    }

    @Test
    fun `POST sync mutations saves a duplicate id only once within one request`() {
        val mutation = Mutation(
            id = "01HTEST0000000000000000020",
            channel = "org:test",
            entityType = "Student",
            entityId = "stu-020",
            op = "CREATE",
            payload = "{}",
            authorIdentityId = "user-1",
            deviceId = "device-1",
            clientTs = "2026-01-01T00:00:00Z",
        )
        val result = mvc.post("/sync/mutations") {
            contentType = MediaType.APPLICATION_JSON
            content = mapper.writeValueAsString(BatchMutationsRequest(listOf(mutation, mutation)))
        }.andExpect { status { isOk() } }.andReturn()

        val response = mapper.readValue(result.response.contentAsString, BatchMutationsResponse::class.java)
        assertEquals(1, response.accepted.size)
        assertEquals(0, response.rejected.size)
        assertTrue(repository.existsById(mutation.id))
    }

    @Test
    fun `GET sync changes returns pushed mutations for the channel`() {
        val id = "01HTEST0000000000000000003"
        mvc.post("/sync/mutations") {
            contentType = MediaType.APPLICATION_JSON
            content = mapper.writeValueAsString(
                BatchMutationsRequest(listOf(
                    Mutation(id, "org:test/school:s2", "Student", "stu-003",
                        "CREATE", "{}", "u1", "d1", "2026-01-01T00:00:00Z")
                ))
            )
        }.andExpect { status { isOk() } }

        val result = mvc.get("/sync/changes") {
            param("channel", "org:test/school:s2")
        }.andExpect { status { isOk() } }.andReturn()

        val response = mapper.readValue(result.response.contentAsString, ChangesResponse::class.java)
        assertTrue(response.mutations.any { it.id == id })
        assertFalse(response.hasMore)
    }

    @Test
    fun `GET sync changes supports sub-channel hierarchy`() {
        val id = "01HTEST0000000000000000004"
        mvc.post("/sync/mutations") {
            contentType = MediaType.APPLICATION_JSON
            content = mapper.writeValueAsString(
                BatchMutationsRequest(listOf(
                    Mutation(id, "org:parent/school:child", "Student", "stu-004",
                        "UPDATE", "{}", "u1", "d1", "2026-01-01T00:00:00Z")
                ))
            )
        }.andExpect { status { isOk() } }

        // Pull from the parent channel — should include sub-channel data
        val result = mvc.get("/sync/changes") {
            param("channel", "org:parent")
        }.andExpect { status { isOk() } }.andReturn()

        val response = mapper.readValue(result.response.contentAsString, ChangesResponse::class.java)
        assertTrue(response.mutations.any { it.id == id }, "Sub-channel mutation should appear in parent pull")
    }

    @Test
    fun `GET sync changes returns tied timestamp mutations exactly once across pages`() {
        val ids = listOf(
            "01HTEST0000000000000000010",
            "01HTEST0000000000000000011",
            "01HTEST0000000000000000012",
        )
        val mutations = ids.map { id ->
            Mutation(
                id,
                "org:pagination",
                "Student",
                "student-$id",
                "CREATE",
                "{}",
                "user-1",
                "device-1",
                "2026-01-01T00:00:00Z",
            )
        }
        mvc.post("/sync/mutations") {
            contentType = MediaType.APPLICATION_JSON
            content = mapper.writeValueAsString(BatchMutationsRequest(mutations))
        }.andExpect { status { isOk() } }

        val received = mutableListOf<String>()
        var since: String? = null
        var lastMutationId: String? = null
        var hasMore: Boolean
        do {
            val result = mvc.get("/sync/changes") {
                param("channel", "org:pagination")
                param("limit", "1")
                since?.let { param("since", it) }
                lastMutationId?.let { param("lastMutationId", it) }
            }.andExpect { status { isOk() } }.andReturn()
            val response = mapper.readValue(result.response.contentAsString, ChangesResponse::class.java)
            received += response.mutations.map { it.id }
            since = response.cursor.lastReceivedAt
            lastMutationId = response.cursor.lastMutationId
            hasMore = response.hasMore
        } while (hasMore && received.size <= ids.size)

        assertEquals(ids, received)
        assertEquals(ids.size, received.toSet().size)
    }

    @Test
    fun `POST sync mutations rejects blank id`() {
        val request = BatchMutationsRequest(listOf(
            Mutation("", "org:test", "Student", "x", "CREATE", "{}", "u", "d", "2026-01-01T00:00:00Z")
        ))
        val result = mvc.post("/sync/mutations") {
            contentType = MediaType.APPLICATION_JSON
            content = mapper.writeValueAsString(request)
        }.andExpect { status { isOk() } }.andReturn()

        val response = mapper.readValue(result.response.contentAsString, BatchMutationsResponse::class.java)
        assertEquals(1, response.rejected.size)
        assertEquals(0, response.accepted.size)
    }

    @Test
    fun `POST sync mutations rejects reserved system author`() {
        val request = BatchMutationsRequest(listOf(
            Mutation(
                "01HTEST0000000000000000005",
                "org:test",
                "Student",
                "x",
                "CREATE",
                "{}",
                "system",
                "d",
                "2026-01-01T00:00:00Z",
            )
        ))
        val result = mvc.post("/sync/mutations") {
            contentType = MediaType.APPLICATION_JSON
            content = mapper.writeValueAsString(request)
        }.andExpect { status { isOk() } }.andReturn()

        val response = mapper.readValue(result.response.contentAsString, BatchMutationsResponse::class.java)
        assertEquals(0, response.accepted.size)
        assertEquals(1, response.rejected.size)
        assertEquals("reserved_author", response.rejected[0].code)
        assertFalse(repository.existsById("01HTEST0000000000000000005"))
    }
}
