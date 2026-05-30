package dev.maayo.spring

import dev.maayo.spring.api.ChangesController
import dev.maayo.spring.api.MutationController
import dev.maayo.spring.jpa.MaayoJpaAutoConfiguration
import org.springframework.boot.autoconfigure.AutoConfiguration
import org.springframework.boot.autoconfigure.AutoConfigureAfter
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean

@AutoConfiguration
@AutoConfigureAfter(MaayoJpaAutoConfiguration::class)
@ConditionalOnProperty(prefix = "maayo", name = ["enabled"], matchIfMissing = true)
@EnableConfigurationProperties(MaayoProperties::class)
class MaayoAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean(ChannelAuthorizer::class)
    fun maayoChannelAuthorizer(): ChannelAuthorizer = PermitAllChannelAuthorizer()

    @Bean
    @ConditionalOnBean(MaayoRepository::class)
    fun maayoMutationController(
        repository: MaayoRepository,
        authorizer: ChannelAuthorizer,
    ) = MutationController(repository, authorizer)

    @Bean
    @ConditionalOnBean(MaayoRepository::class)
    fun maayoChangesController(
        repository: MaayoRepository,
        authorizer: ChannelAuthorizer,
        properties: MaayoProperties,
    ) = ChangesController(repository, authorizer, properties)
}
