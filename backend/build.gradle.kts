plugins {
    java
    id("org.springframework.boot") version "3.5.3"
    id("io.spring.dependency-management") version "1.1.7"
}

group = "com.webcode"
version = "0.1.0"
description = "Web-based coding assistant backend (Spring Boot + LangChain4j + JGit)"

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(21)
    }
}

repositories {
    mavenCentral()
}

extra["jgitVersion"] = "7.3.0.202506031305-r"
extra["langchain4jVersion"] = "1.0.0"
extra["jjwtVersion"] = "0.12.6"
extra["flywayVersion"] = "11.8.2"

dependencies {
    // --- web / sse ---------------------------------------------------------
    implementation("org.springframework.boot:spring-boot-starter-web")
    implementation("org.springframework.boot:spring-boot-starter-validation")

    // --- persistence -------------------------------------------------------
    // 数据库是 MySQL 8（8.0.13+）。驱动用 MySQL 官方 Connector/J；
    // Flyway 的方言支持在 10 之后拆成了独立模块，MySQL 对应 flyway-mysql。
    implementation("org.springframework.boot:spring-boot-starter-jdbc")
    implementation("org.flywaydb:flyway-core:${property("flywayVersion")}")
    runtimeOnly("org.flywaydb:flyway-mysql:${property("flywayVersion")}")
    runtimeOnly("com.mysql:mysql-connector-j")

    // --- redis（限流 / 用量计数，缺失时自动降级为进程内实现）------------------
    implementation("org.springframework.boot:spring-boot-starter-data-redis")

    // --- security ----------------------------------------------------------
    implementation("org.springframework.boot:spring-boot-starter-security")
    implementation("io.jsonwebtoken:jjwt-api:${property("jjwtVersion")}")
    runtimeOnly("io.jsonwebtoken:jjwt-impl:${property("jjwtVersion")}")
    runtimeOnly("io.jsonwebtoken:jjwt-jackson:${property("jjwtVersion")}")

    // --- mail（邮箱验证 / 找回密码）----------------------------------------
    // 只在 app.mail.mode=smtp 时才会真正建出 JavaMailSender；dev 模式下
    // 应用根本不碰它（见 MailConfig 的条件装配），因此本地开发不需要任何 SMTP 账号。
    implementation("org.springframework.boot:spring-boot-starter-mail")

    // --- LLM / Agent -------------------------------------------------------
    // 只依赖 LangChain4j 核心 + open-ai 适配器；其官方 spring-boot-starter 仍停留在
    // 1.0.0-beta5，落后于核心 1.0.0，因此这里用显式 @Bean 配置模型（见 llm/ChatModelConfig）。
    implementation("dev.langchain4j:langchain4j:${property("langchain4jVersion")}")
    implementation("dev.langchain4j:langchain4j-open-ai:${property("langchain4jVersion")}")
    implementation("dev.langchain4j:langchain4j-http-client-jdk:${property("langchain4jVersion")}")

    // --- git ---------------------------------------------------------------
    implementation("org.eclipse.jgit:org.eclipse.jgit:${property("jgitVersion")}")

    // --- zip 导入（启用 zip-slip / zip-bomb 防护）--------------------------
    implementation("org.apache.commons:commons-compress:1.28.0")

    // --- test --------------------------------------------------------------
    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
    options.compilerArgs.add("-parameters")
}

tasks.withType<Test>().configureEach {
    useJUnitPlatform()
    testLogging {
        events("passed", "skipped", "failed")
    }
}
