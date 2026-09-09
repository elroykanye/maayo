package dev.maayo.spring.api

import dev.maayo.spring.ChannelAuthorizer
import dev.maayo.spring.DuplicateMutationException
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
            if (!seenIds.add(mutation.id)) continue
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

                repository.existsById(mutation.id) -> {
                    // Idempotent re-delivery — acknowledge without re-saving
                    accepted += AcceptedMutation(mutation.id, Instant.now().toString())
                }

                else -> toSave += mutation
            }
        }

        persistWithDuplicateRecovery(toSave, accepted)

        return BatchMutationsResponse(accepted = accepted, rejected = rejected)
    }

    private fun persistWithDuplicateRecovery(
        mutations: List<Mutation>,
        accepted: MutableList<AcceptedMutation>,
    ) {
        var remaining = mutations
        while (remaining.isNotEmpty()) {
            try {
                acceptSaved(repository.saveAll(remaining), accepted)
                return
            } catch (error: DuplicateMutationException) {
                val unresolved = mutableListOf<Mutation>()
                remaining.forEach { mutation ->
                    if (repository.existsById(mutation.id)) {
                        accepted += AcceptedMutation(mutation.id, Instant.now().toString())
                    } else {
                        unresolved += mutation
                    }
                }
                if (unresolved.size == remaining.size) throw error
                remaining = unresolved
            }
        }
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
