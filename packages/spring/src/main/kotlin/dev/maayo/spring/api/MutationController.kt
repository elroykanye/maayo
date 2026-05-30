package dev.maayo.spring.api

import dev.maayo.spring.ChannelAuthorizer
import dev.maayo.spring.MaayoRepository
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

        for (mutation in request.mutations) {
            when {
                mutation.id.isBlank() ->
                    rejected += RejectedMutation(mutation.id, "id is required")

                !authorizer.canPush(principal, mutation.channel) ->
                    rejected += RejectedMutation(mutation.id, "unauthorized for channel ${mutation.channel}")

                repository.existsById(mutation.id) -> {
                    // Idempotent re-delivery — acknowledge without re-saving
                    accepted += AcceptedMutation(mutation.id, Instant.now().toString())
                }

                else -> toSave += mutation
            }
        }

        if (toSave.isNotEmpty()) {
            repository.saveAll(toSave).forEach { saved ->
                accepted += AcceptedMutation(saved.mutation.id, saved.receivedAt.toString())
            }
        }

        return BatchMutationsResponse(accepted = accepted, rejected = rejected)
    }
}
