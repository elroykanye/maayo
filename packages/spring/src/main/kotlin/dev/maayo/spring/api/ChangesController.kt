package dev.maayo.spring.api

import dev.maayo.spring.ChannelAuthorizer
import dev.maayo.spring.MaayoProperties
import dev.maayo.spring.MaayoRepository
import dev.maayo.spring.SavedMutation
import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.server.ResponseStatusException
import java.security.Principal
import java.time.Instant

@RestController
@RequestMapping("/sync")
class ChangesController(
    private val repository: MaayoRepository,
    private val authorizer: ChannelAuthorizer,
    private val properties: MaayoProperties,
) {
    @GetMapping("/changes")
    fun pull(
        @RequestParam channel: String,
        @RequestParam(required = false) since: String?,
        @RequestParam(required = false) lastMutationId: String?,
        @RequestParam(required = false) limit: Int?,
        principal: Principal?,
    ): ChangesResponse {
        if (!authorizer.canPull(principal, channel)) {
            throw ResponseStatusException(HttpStatus.FORBIDDEN, "unauthorized for channel $channel")
        }

        val effectiveLimit = (limit ?: properties.defaultLimit).coerceIn(1, 2000)
        val sinceInstant = since?.let { runCatching { Instant.parse(it) }.getOrNull() }
        val rows = repository.findChanges(channel, sinceInstant, lastMutationId, effectiveLimit + 1)

        val hasMore = rows.size > effectiveLimit
        val page = if (hasMore) rows.dropLast(1) else rows

        val cursor = buildCursor(page)

        return ChangesResponse(
            channel = channel,
            mutations = page.map { it.toDto() },
            cursor = cursor,
            hasMore = hasMore,
        )
    }

    private fun buildCursor(page: List<SavedMutation>): Cursor {
        val last = page.lastOrNull() ?: return Cursor(null, null)
        return Cursor(
            lastMutationId = last.mutation.id,
            lastReceivedAt = last.receivedAt.toString(),
        )
    }

    private fun SavedMutation.toDto() = mutation
}
