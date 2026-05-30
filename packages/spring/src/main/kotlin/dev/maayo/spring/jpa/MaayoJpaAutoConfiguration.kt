package dev.maayo.spring.jpa

import com.fasterxml.jackson.databind.ObjectMapper
import dev.maayo.spring.MaayoRepository
import org.springframework.boot.autoconfigure.AutoConfiguration
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean
import org.springframework.context.annotation.Bean
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.config.EnableJpaRepositories

@AutoConfiguration
@ConditionalOnClass(JpaRepository::class)
@EnableJpaRepositories(basePackageClasses = [MaayoMutationJpaRepository::class])
class MaayoJpaAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean(MaayoRepository::class)
    fun maayoRepository(
        jpa: MaayoMutationJpaRepository,
        mapper: ObjectMapper,
    ): MaayoRepository = JpaMaayoRepository(jpa, mapper)
}
