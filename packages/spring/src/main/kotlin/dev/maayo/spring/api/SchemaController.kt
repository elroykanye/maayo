package dev.maayo.spring.api

import dev.maayo.spring.MaayoProperties
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

/**
 * OPTIONAL third protocol endpoint: `GET /sync/schema` — the server's declared
 * conflict policy per entity type (from `maayo.policies.*`). A policy-aware
 * client (`@maayo/client`'s `policyApply`) uses it to branch on the SAME
 * policy this server's appliers enforce, so both sides run one merge function
 * over the mutation log. Serves an empty list until policies are declared;
 * clients treat empty/absent as "everything is LWW".
 */
@RestController
@RequestMapping("/sync")
class SchemaController(
    private val properties: MaayoProperties,
) {
    @GetMapping("/schema")
    fun schema(): SchemaResponse =
        SchemaResponse(
            entities = properties.policies.entries
                .sortedBy { it.key }
                .map { (entityType, policy) -> EntitySchema(entityType, policy.uppercase()) },
        )
}
