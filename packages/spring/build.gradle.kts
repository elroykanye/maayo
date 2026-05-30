plugins {
    kotlin("jvm") version "2.1.21"
    kotlin("plugin.spring") version "2.1.21"
    kotlin("plugin.jpa") version "2.1.21"
    `java-library`
    `maven-publish`
}

group = "dev.maayo"
version = "0.1.0"

repositories {
    mavenCentral()
}

val springBootVersion = "3.4.5"
val jacksonVersion = "2.19.0"

dependencies {
    // Spring Boot autoconfigure is always needed; web + jpa are optional at compile time
    compileOnly("org.springframework.boot:spring-boot-autoconfigure:$springBootVersion")
    compileOnly("org.springframework.boot:spring-boot-starter-web:$springBootVersion")
    compileOnly("org.springframework.boot:spring-boot-starter-data-jpa:$springBootVersion")
    compileOnly("com.fasterxml.jackson.module:jackson-module-kotlin:$jacksonVersion")
    compileOnly("jakarta.persistence:jakarta.persistence-api:3.1.0")
    compileOnly("jakarta.servlet:jakarta.servlet-api:6.1.0")

    implementation(kotlin("reflect"))

    // Test
    testImplementation("org.springframework.boot:spring-boot-starter-test:$springBootVersion")
    testImplementation("org.springframework.boot:spring-boot-starter-web:$springBootVersion")
    testImplementation("org.springframework.boot:spring-boot-starter-data-jpa:$springBootVersion")
    testImplementation("com.h2database:h2:2.3.232")
    testImplementation("com.fasterxml.jackson.module:jackson-module-kotlin:$jacksonVersion")
}

kotlin {
    jvmToolchain(17)
}

tasks.test {
    useJUnitPlatform()
}

publishing {
    publications {
        create<MavenPublication>("maven") {
            from(components["java"])
            pom {
                name.set("maayo-spring")
                description.set("Spring Boot autoconfiguration for the Maayo offline sync protocol")
                licenses {
                    license {
                        name.set("MIT")
                    }
                }
            }
        }
    }
}
