# ---------- 构建阶段 ----------
# 用带 JDK 21 的镜像编译。Gradle 用仓库里自带的 wrapper，保证与本地版本一致。
FROM eclipse-temurin:21-jdk AS build

WORKDIR /build

# 先只拷构建脚本并预热依赖：源码变动时这一层可以命中缓存，重新构建快很多
COPY gradlew gradlew
COPY gradle gradle
COPY settings.gradle.kts build.gradle.kts gradle.properties ./
RUN chmod +x gradlew && ./gradlew --no-daemon --console=plain dependencies > /dev/null

COPY src src
RUN ./gradlew --no-daemon --console=plain bootJar

# ---------- 运行阶段 ----------
FROM eclipse-temurin:21-jre-alpine

# curl 用于 healthcheck（alpine 的 busybox wget 也行，但 curl 更可靠）
RUN apk add --no-cache curl tzdata git \
    && addgroup -S app && adduser -S -G app app

WORKDIR /app

COPY --from=build /build/build/libs/*.jar /app/app.jar

# 工作区目录：容器内固定路径，由 compose 挂载为具名卷，容器重建不会丢代码
RUN mkdir -p /data/workspaces && chown -R app:app /data /app
VOLUME ["/data/workspaces"]

USER app
EXPOSE 8080

ENV WORKSPACE_ROOT=/data/workspaces \
    JAVA_OPTS="-XX:MaxRAMPercentage=70 -Duser.timezone=Asia/Shanghai"

HEALTHCHECK --interval=15s --timeout=5s --start-period=50s --retries=10 \
  CMD curl -fsS http://127.0.0.1:8080/api/health || exit 1

ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS -jar /app/app.jar"]
