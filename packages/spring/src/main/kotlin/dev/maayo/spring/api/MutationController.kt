package dev.maayo.spring.api

import dev.maayo.spring.ChannelAuthorizer
import dev.maayo.spring.MaayoRepository
import dev.maayo.spring.SavedMutation
import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.server.ResponseStatusException
import java.security.Principal
import java.time.Instant

@RestController
@RequestMapping("/sync")
class MutationController(
    private val repository: MaayoRepository,
    private val authorizer: ChannelAuthorizer,
) {
    @PostMapping("/mutations")
    fun push(
        @RequestBody request: BatchMutationsRequest,
        principal: Principal?,
    ): BatchMutationsResponse {
        val accepted = mutableListOf<AcceptedMutation>()
        val rejected = mutableListOf<RejectedMutation>()

        val toSave = mutableListOf<Mutation>()
        val seenIds = mutableSetOf<String>()

        for (mutation in request.mutations) {
            when {
                mutation.id.isBlank() ->
                    rejected += RejectedMutation(mutation.id, "id is required")

                mutation.authorIdentityId == SYSTEM_AUTHOR ->
                    rejected += RejectedMutation(
                        mutation.id,
                        "reserved author identity",
                        "reserved_author",
                    )

                !authorizer.canPush(principal, mutation.channel) ->
                    rejected += RejectedMutation(mutation.id, "unauthorized for channel ${mutation.channel}")

                !seenIds.add(mutation.id) -> Unit

                repository.existsById(mutation.id) -> {
                    // Idempotent re-delivery — acknowledge without re-saving
                    accepted += AcceptedMutation(mutation.id, Instant.now().toString())
                }

                else -> toSave += mutation
            }
        }

        if (toSave.isNotEmpty()) {
            try {
                acceptSaved(repository.saveAll(toSave), accepted)
            } catch (error: RuntimeException) {
                val remaining = mutableListOf<Mutation>()
                toSave.forEach { mutation ->
                    if (repository.existsById(mutation.id)) {
                        accepted += AcceptedMutation(mutation.id, Instant.now().toString())
                    } else {
                        remaining += mutation
                    }
                }
                if (remaining.size == toSave.size) throw error
                if (remaining.isNotEmpty()) {
                    acceptSaved(repository.saveAll(remaining), accepted)
                }
            }
        }

        return BatchMutationsResponse(accepted = accepted, rejected = rejected)
    }

    private fun acceptSaved(saved: List<SavedMutation>, accepted: MutableList<AcceptedMutation>) {
        saved.forEach { row ->
            accepted += AcceptedMutation(row.mutation.id, row.receivedAt.toString())
        }
    }

    private companion object {
        const val SYSTEM_AUTHOR = "system"
    }
}
