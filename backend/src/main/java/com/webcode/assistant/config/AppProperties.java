package com.webcode.assistant.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

import java.time.Duration;
import java.util.List;

/**
 * 应用级配置（环境变量优先，见 application.yml 的占位符）。
 *
 * <p>所有与安全强相关的阈值都集中在这里：工作区根目录、体积上限、单文件读取上限、
 * 搜索条数上限、CORS 白名单、JWT 密钥、克隆超时。
 */
@ConfigurationProperties(prefix = "app")
public record AppProperties(

        /** 所有工作区所在的根目录，工作区之间以子目录隔离。 */
        @DefaultValue("./data/workspaces") String workspaceRoot,

        /** 单个工作区磁盘体积上限，默认 200MB。 */
        @DefaultValue("209715200") long maxWorkspaceBytes,

        /** 单次 read_file 返回上限，默认 512KB，超出截断并标记 truncated。 */
        @DefaultValue("524288") long maxReadBytes,

        /** grep 结果条数上限，防止工具结果无限回灌进上下文。 */
        @DefaultValue("50") int grepMaxResults,

        /** 单次文件树返回的最大条目数，防止超大仓库把前端打爆。 */
        @DefaultValue("20000") int maxTreeEntries,

        /** 上传 zip 解压后的最大条目数（zip bomb 防护）。 */
        @DefaultValue("20000") int maxArchiveEntries,

        @DefaultValue Cors cors,

        @DefaultValue Jwt jwt,

        /**
         * 组件名刻意叫 {@code gitClone} 而不是 {@code clone}：
         * record 会为组件生成同名访问器，叫 clone 会和 {@code Object.clone()} 撞名，
         * 导致 {@code properties.clone()} 解析到受保护的 Object 方法上而编译失败。
         */
        @DefaultValue GitClone gitClone,

        /** 补丁应用后的编译验证（「编译闭环」的沙箱侧配置）。 */
        @DefaultValue Compile compile,

        /** 网页终端（功能 12）。这是给人用的命令入口，模型永远没有 run_command 工具。 */
        @DefaultValue Terminal terminal
) {

    public record Cors(
            /** 仅放行前端 origin，不使用通配符。 */
            @DefaultValue({"http://localhost:5173", "http://127.0.0.1:5173"}) List<String> allowedOrigins
    ) {
    }

    public record Jwt(
            @DefaultValue("dev-only-secret-please-override-with-32-bytes-at-least") String secret,
            @DefaultValue("PT24H") Duration ttl
    ) {
    }

    public record GitClone(
            @DefaultValue("PT180S") Duration timeout,
            /** JGit 浅克隆深度，默认 1，避免拉全量历史。 */
            @DefaultValue("1") int depth
    ) {
    }

    /**
     * 编译验证配置。
     *
     * <p>为什么把命令做成可配置而不是写死 {@code mvn compile}：企业内网普遍有自己的
     * Maven/Gradle 安装位置、settings.xml（私服镜像）与 JDK 路径，写死等于只能用默认环境。
     *
     * <p>{@code javaHome} 留空表示继承后端进程的环境变量。很多机器上 {@code JAVA_HOME} 是
     * JDK 8（老项目遗留），而工作区要求 Java 17+，这时必须显式指定，否则编译会因为
     * 「invalid target release: 17」失败 —— 那是个环境问题，不该被当成代码错误喂给模型。
     */
    public record Compile(
            @DefaultValue("true") boolean enabled,

            /** 注册中心里 {@code mvn} / {@code gradle} 的名字，也可以填绝对路径。 */
            @DefaultValue("mvn") String mavenCommand,

            @DefaultValue("gradle") String gradleCommand,

            /** 编译用的 JAVA_HOME，留空则继承进程环境。 */
            @DefaultValue("") String javaHome,

            /** 可选：传给 Maven 的 {@code -s settings.xml}，用于指向私服镜像。 */
            @DefaultValue("") String mavenSettings,

            /** 是否以离线模式编译（{@code mvn -o}）。本地仓库已预热时更快、更可控。 */
            @DefaultValue("false") boolean offline,

            @DefaultValue("PT240S") Duration timeout,

            /** 保留的编译器输出上限，超出只留尾部（错误通常在最末尾）。 */
            @DefaultValue("24000") int maxOutputChars
    ) {
    }

    /**
     * 网页终端配置。
     *
     * <p>安全模型与 Docker 沙箱方案（V2）不同：本地部署没有 Docker 时，终端降级为
     * 「受限的单命令执行」—— cwd 锁定工作区、拒绝 shell 元字符（无管道 / 重定向 / 命令链）、
     * 超时杀进程、输出截断。它只由登录用户在前端手动触发，<b>永远不会暴露给模型</b>：
     * 「模型不能执行命令」是本项目从第一天起就守住的红线。
     */
    public record Terminal(
            @DefaultValue("true") boolean enabled,

            @DefaultValue("PT120S") Duration timeout,

            /** 保留的输出上限，超出截断并标记。 */
            @DefaultValue("65536") int maxOutputChars
    ) {
    }
}
