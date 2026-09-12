package dev.maayo.spring

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import dev.maayo.spring.api.CheckpointController
import dev.maayo.spring.api.ChangesController
import dev.maayo.spring.api.Cursor
import dev.maayo.spring.api.Mutation
import com.aayushatharva.brotli4j.Brotli4jLoader
import com.aayushatharva.brotli4j.decoder.Decoder
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.http.HttpHeaders
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.get
import org.springframework.test.web.servlet.setup.MockMvcBuilders
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.security.Principal
import java.time.Instant
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.zip.GZIPInputStream

class CheckpointProtocolIntegrationTest {
    private val mapper = jacksonObjectMapper()
    private val resolver = DefaultCheckpointProjectionResolver()

    @Test
    fun `stale replay returns explicit CHECKPOINT_REQUIRED without reading an unsafe tail`() {
        val repository = RecordingRepository()
        val floor = Cursor("01HFLOOR000000000000000001", "2026-09-01T00:00:00Z")
        val provider = FixedProvider(
            replay = RetainedReplay.CheckpointRequired(floor),
        )
        val mvc = changesMvc(repository, provider)

        val response = mvc.get("/sync/changes") {
            param("channel", "org:one")
            param("since", "2026-08-01T00:00:00Z")
            param("lastMutationId", "01HSTALE00000000000000001")
        }.andExpect {
            status { isConflict() }
            jsonPath("$.code") { value("CHECKPOINT_REQUIRED") }
            jsonPath("$.retainedLogFloor.lastMutationId") { value(floor.lastMutationId) }
        }.andReturn().response

        assertEquals("no-store", response.getHeader(HttpHeaders.CACHE_CONTROL))
        assertEquals(0, repository.readCount)
    }

    @Test
    fun `checkpoint plus a concurrently appended delta is gap and duplicate safe`() {
        val initial = saved("01HCP00000000000000000001", "student-1", "CREATE", "{\"name\":\"Ada\"}", 1)
        val concurrent = saved("01HCP00000000000000000002", "student-2", "CREATE", "{\"name\":\"Grace\"}", 2)
        val repository = RecordingRepository(mutableListOf(initial))
        val captured = CountDownLatch(1)
        val release = CountDownLatch(1)
        val provider = object : CheckpointProvider {
            override fun createCheckpoint(request: CheckpointRequest): CheckpointSnapshot {
                val consistentView = repository.snapshot()
                captured.countDown()
                assertTrue(release.await(5, TimeUnit.SECONDS))
                return CheckpointSnapshot(
                    schemaVersion = "students-v1",
                    throughCursor = consistentView.last().cursor(),
                    rows = consistentView.map {
                        CheckpointRow(it.mutation.entityType, it.mutation.entityId, it.mutation.payload)
                    },
                    mergeMetadata = mapOf("Student" to "LWW"),
                )
            }
        }
        val checkpointMvc = checkpointMvc(provider)
        val changesMvc = changesMvc(repository, provider)
        val executor = Executors.newSingleThreadExecutor()

        try {
            val responseFuture = executor.submit<ByteArray> {
                checkpointMvc.get("/sync/checkpoint") {
                    param("channel", "org:one")
                    with { it.apply { userPrincipal = named("alice") } }
                }.andExpect { status { isOk() } }.andReturn().response.contentAsByteArray
            }
            assertTrue(captured.await(5, TimeUnit.SECONDS))
            repository.append(concurrent)
            release.countDown()

            val envelope = mapper.readTree(responseFuture.get(5, TimeUnit.SECONDS))
            val through = envelope["throughCursor"]
            val tailResponse = changesMvc.get("/sync/changes") {
                param("channel", "org:one")
                param("since", through["lastReceivedAt"].asText())
                param("lastMutationId", through["lastMutationId"].asText())
                with { it.apply { userPrincipal = named("alice") } }
            }.andExpect { status { isOk() } }.andReturn().response
            val tail = mapper.readTree(tailResponse.contentAsByteArray)["mutations"].map { it["id"].asText() }
            val checkpointIds = envelope["rows"].map { it["entityId"].asText() }

            assertEquals(listOf("student-1"), checkpointIds)
            assertEquals(listOf(concurrent.mutation.id), tail)
            assertEquals(2, (checkpointIds + tail).toSet().size)
        } finally {
            release.countDown()
            executor.shutdownNow()
        }
    }

    @Test
    fun `checkpoint preserves tombstones and carries merge and integrity metadata`() {
        val provider = FixedProvider(
            snapshot = CheckpointSnapshot(
                schemaVersion = "students-v3",
                throughCursor = Cursor("01HCP00000000000000000003", "2026-09-01T00:00:03Z"),
                rows = listOf(
                    CheckpointRow(
                        entityType = "Student",
                        entityId = "student-deleted",
                        payload = null,
                        tombstone = true,
                        deletedAt = "2026-09-01T00:00:02Z",
                        mergeMetadata = mapOf("winnerMutationId" to "01HCP00000000000000000003"),
                    ),
                ),
                mergeMetadata = mapOf("Student" to "LWW"),
            ),
        )

        val response = checkpointMvc(provider).get("/sync/checkpoint") {
            param("channel", "org:one")
            param("projection", "mobile")
            with { it.apply { userPrincipal = named("alice") } }
        }.andExpect {
            status { isOk() }
            jsonPath("$.protocolVersion") { value(1) }
            jsonPath("$.schemaVersion") { value("students-v3") }
            jsonPath("$.projection") { value("mobile") }
            jsonPath("$.projectionRevision") { value("identity-v1") }
            jsonPath("$.rows[0].tombstone") { value(true) }
            jsonPath("$.rows[0].deletedAt") { value("2026-09-01T00:00:02Z") }
            jsonPath("$.rows[0].payload.deletedAt") { value("2026-09-01T00:00:02Z") }
            jsonPath("$.mergeMetadata[0].entityType") { value("Student") }
            jsonPath("$.mergeMetadata[0].value.winnerMutationId") { value("01HCP00000000000000000003") }
            jsonPath("$.integrity.algorithm") { value("sha-256") }
            jsonPath("$.integrity.scope") { value("rows-and-merge-metadata") }
        }.andReturn().response

        assertTrue(response.getHeader("Digest")!!.startsWith("sha-256=:"))
    }

    @Test
    fun `authorization projection key isolates private validators`() {
        val provider = FixedProvider()
        val mvc = checkpointMvc(provider)

        val alice = mvc.get("/sync/checkpoint") {
            param("channel", "org:one")
            with { it.apply { userPrincipal = named("alice") } }
        }.andExpect { status { isOk() } }.andReturn().response
        val bob = mvc.get("/sync/checkpoint") {
            param("channel", "org:one")
            with { it.apply { userPrincipal = named("bob") } }
        }.andExpect { status { isOk() } }.andReturn().response

        val aliceBody = mapper.readTree(alice.contentAsByteArray)
        val bobBody = mapper.readTree(bob.contentAsByteArray)
        assertNotEquals(aliceBody["projectionKey"].asText(), bobBody["projectionKey"].asText())
        assertNotEquals(alice.getHeader(HttpHeaders.ETAG), bob.getHeader(HttpHeaders.ETAG))
        assertTrue(alice.getHeader(HttpHeaders.CACHE_CONTROL)!!.contains("private"))
        assertTrue(alice.getHeaders(HttpHeaders.VARY).flatMap { it.split(",") }.map { it.trim() }.contains("Authorization"))
    }

    @Test
    fun `checkpoint supports conditional requests gzip and brotli without changing integrity`() {
        val mvc = checkpointMvc(FixedProvider())
        val identity = mvc.get("/sync/checkpoint") {
            param("channel", "org:one")
            with { it.apply { userPrincipal = named("alice") } }
        }.andExpect { status { isOk() } }.andReturn().response
        val etag = identity.getHeader(HttpHeaders.ETAG)!!

        mvc.get("/sync/checkpoint") {
            param("channel", "org:one")
            header(HttpHeaders.IF_NONE_MATCH, etag)
            with { it.apply { userPrincipal = named("alice") } }
        }.andExpect {
            status { isNotModified() }
            content { bytes(ByteArray(0)) }
        }

        val gzip = mvc.get("/sync/checkpoint") {
            param("channel", "org:one")
            header(HttpHeaders.ACCEPT_ENCODING, "gzip")
            with { it.apply { userPrincipal = named("alice") } }
        }.andExpect {
            status { isOk() }
            header { string(HttpHeaders.CONTENT_ENCODING, "gzip") }
        }.andReturn().response
        val br = mvc.get("/sync/checkpoint") {
            param("channel", "org:one")
            header(HttpHeaders.ACCEPT_ENCODING, "br, gzip;q=0.5")
            with { it.apply { userPrincipal = named("alice") } }
        }.andExpect {
            status { isOk() }
            header { string(HttpHeaders.CONTENT_ENCODING, "br") }
        }.andReturn().response

        assertEquals(mapper.readTree(identity.contentAsByteArray), mapper.readTree(gunzip(gzip.contentAsByteArray)))
        assertEquals(mapper.readTree(identity.contentAsByteArray), mapper.readTree(unbrotli(br.contentAsByteArray)))
        assertEquals(etag, gzip.getHeader(HttpHeaders.ETAG))
        assertEquals(etag, br.getHeader(HttpHeaders.ETAG))
    }

    private fun checkpointMvc(provider: CheckpointProvider): MockMvc = MockMvcBuilders.standaloneSetup(
        CheckpointController(provider, PermitAllChannelAuthorizer(), resolver, mapper),
    ).build()

    private fun changesMvc(repository: MaayoRepository, provider: CheckpointProvider): MockMvc =
        MockMvcBuilders.standaloneSetup(
            ChangesController(repository, PermitAllChannelAuthorizer(), MaayoProperties(), provider, resolver),
        ).build()

    private fun named(name: String) = Principal { name }

    private fun saved(id: String, entityId: String, op: String, payload: String, second: Long): SavedMutation =
        SavedMutation(
            Mutation(id, "org:one", "Student", entityId, op, payload, "user", "device", "2026-09-01T00:00:00Z"),
            Instant.parse("2026-09-01T00:00:0${second}Z"),
        )

    private fun SavedMutation.cursor() = Cursor(mutation.id, receivedAt.toString())

    private fun gunzip(bytes: ByteArray): ByteArray = GZIPInputStream(ByteArrayInputStream(bytes)).readAllBytes()
    private fun unbrotli(bytes: ByteArray): ByteArray {
        Brotli4jLoader.ensureAvailability()
        return Decoder.decompress(bytes).decompressedData
    }

    private class RecordingRepository(
        private val mutations: MutableList<SavedMutation> = mutableListOf(),
    ) : MaayoRepository {
        var readCount = 0
            private set

        override fun existsById(id: String) = mutations.any { it.mutation.id == id }
        override fun saveAll(mutations: List<Mutation>) = emptyList<SavedMutation>()
        override fun findChanges(channel: String, since: Instant?, limit: Int): List<SavedMutation> =
            findChanges(channel, since, null, limit)

        override fun findChanges(channel: String, since: Instant?, lastMutationId: String?, limit: Int): List<SavedMutation> {
            readCount++
            return synchronized(mutations) {
                mutations.filter {
                    since == null || it.receivedAt > since ||
                        (it.receivedAt == since && it.mutation.id > requireNotNull(lastMutationId))
                }.sortedWith(compareBy<SavedMutation> { it.receivedAt }.thenBy { it.mutation.id }).take(limit)
            }
        }

        fun snapshot(): List<SavedMutation> = synchronized(mutations) { mutations.toList() }
        fun append(mutation: SavedMutation) = synchronized(mutations) { mutations.add(mutation) }
    }

    private class FixedProvider(
        private val snapshot: CheckpointSnapshot = CheckpointSnapshot(
            schemaVersion = "v1",
            throughCursor = Cursor("01HCP00000000000000000001", "2026-09-01T00:00:01Z"),
            rows = listOf(CheckpointRow("Student", "student-1", "{\"name\":\"Ada\"}")),
        ),
        private val replay: RetainedReplay? = null,
    ) : CheckpointProvider {
        override fun createCheckpoint(request: CheckpointRequest) = snapshot

        override fun readRetainedChanges(
            request: CheckpointReplayRequest,
            load: () -> List<SavedMutation>,
        ): RetainedReplay = replay ?: RetainedReplay.Available(load())
    }
}
