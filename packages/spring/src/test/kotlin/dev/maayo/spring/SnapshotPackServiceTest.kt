package dev.maayo.spring

import com.fasterxml.jackson.databind.ObjectMapper
import dev.maayo.spring.api.Cursor
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class SnapshotPackServiceTest {
    @Test
    fun `delivery token and identity isolate immutable chunks`() {
        val provider = object : CheckpointProvider {
            override fun createCheckpoint(request: CheckpointRequest) = CheckpointSnapshot(
                schemaVersion = "3",
                throughCursor = Cursor("m-9", "2026-09-24T00:00:00.000Z"),
                rows = listOf(
                    CheckpointRow(
                        entityType = "Student",
                        entityId = "s-1",
                        payload = "{\"id\":\"s-1\",\"name\":\"Ada\"}",
                    ),
                ),
            )
        }
        val service = SnapshotPackService(
            provider,
            ObjectMapper().findAndRegisterModules(),
            "0123456789abcdef0123456789abcdef",
            1,
            300,
        )
        val projection = CheckpointProjection("default", "member:42", "grants:7")
        val manifest = service.manifest("tenant-a", "org:1", projection)
        val reference = manifest.chunks.single()

        val chunk = service.chunk(
            "tenant-a", "org:1", "member:42", reference.digest, manifest.deliveryToken,
        )
        assertNotNull(chunk)
        assertEquals(reference.digest, chunk!!.digest)
        assertNull(service.chunk("tenant-b", "org:1", "member:42", reference.digest, manifest.deliveryToken))
        assertNull(service.chunk("tenant-a", "org:1", "member:42", reference.digest, "wrong-token"))
    }
}
