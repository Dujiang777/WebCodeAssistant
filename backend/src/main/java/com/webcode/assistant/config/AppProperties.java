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
        @DefaultValue Terminal terminal,

        /** 账号体系：邮箱验证、登录失败锁定、是否强制验证邮箱。 */
        @DefaultValue Auth auth,

        /** 邮件通道：dev 落库并写日志，smtp 走真实发信。 */
        @DefaultValue Mail mail,

        /** AI 用量积分：赠送额度、计价单价、预扣估算值。 */
        @DefaultValue Credit credit
) {

    public record Cors(
            /** 仅放行前端 origin，不使用通配符。 */
            @DefaultValue({"http://localhost:5173", "http://127.0.0.1:5173"}) List<String> allowedOrigins
    ) {
    }

    public record Jwt(
            @DefaultValue("dev-only-secret-please-override-with-32-bytes-at-least") String secret,

            /**
             * access token 有效期。默认 2 小时 —— 它短一点没关系，
             * 因为客户端手里有 refresh token 可以静默续期。
             * 反过来，如果 access 很长（比如 30 天），泄露就等于 30 天不可撤销。
             */
            @DefaultValue("PT2H") Duration ttl,

            /** refresh token 有效期。默认 30 天，且落库可撤销。 */
            @DefaultValue("PT720H") Duration refreshTtl
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

    /**
     * 账号体系策略。
     *
     * <p>{@code maxFailedAttempts} / {@code lockDuration} 是两个必须有值的阈值：
     * 没有锁定，密码就能被无限次撞，等于没有密码。刻意不写「锁定后自动解锁需要多久」
     * 这种模糊逻辑 —— 到点自动解锁就够，人工解锁交给管理端。
     *
     * <p>{@code requireVerifiedEmail} 默认 <b>关</b>：存量账号与演示账号都没有邮箱，
     * 一上来就硬性拦截会把老用户锁在门外。开启后未验证邮箱的账号不能调用模型
     * （文件浏览、编辑仍然可用），这是控制盗刷的常见做法。
     */
    public record Auth(
            @DefaultValue("5") int maxFailedAttempts,

            @DefaultValue("PT15M") Duration lockDuration,

            /** 邮箱验证 / 重置密码的令牌有效期。 */
            @DefaultValue("PT30M") Duration tokenTtl,

            /** 同一邮箱两次发送之间的最小间隔，防止被当成短信轰炸机。 */
            @DefaultValue("PT60S") Duration resendCooldown,

            @DefaultValue("false") boolean requireVerifiedEmail,

            /** 前端地址，用于拼接验证 / 重置链接。 */
            @DefaultValue("http://localhost:5173") String frontendBaseUrl,

            /**
             * 管理员用户名引导名单。
             *
             * <p>为什么需要它：管理端接口要 ADMIN 角色，但全新部署的库里一个管理员都没有，
             * 而「第一个管理员」又没法自己给自己授权。常见做法是在部署时 SQL 改角色，
             * 但那要求运维记住这条命令；写进配置则随应用启动自动生效。
             *
             * <p><b>默认必须为空</b>，且只在「该账号还不是 ADMIN」时单向提升 ——
             * 它绝不能被理解成「名单里的人永远是管理员」，否则移出名单、降权都会失效。
             * 上线后建议在库里手工建好管理员，再把这个名单清空。
             */
            @DefaultValue List<String> adminUsernames
    ) {
    }

    /**
     * 邮件通道。
     *
     * <p>{@code mode=dev}：不发真邮件，令牌落库并把链接写进日志，同时
     * （仅 dev）通过接口原样返回，方便本地和自检脚本全流程跑通。
     * 上线时把 mode 改成 {@code smtp} 并填好 host/port/username/password 即可，
     * 业务代码一行都不用动。
     */
    public record Mail(
            @DefaultValue("dev") String mode,

            @DefaultValue("") String from,

            @DefaultValue("") String host,

            @DefaultValue("587") int port,

            @DefaultValue("") String username,

            @DefaultValue("") String password,

            /** true = 465 端口走隐式 SSL；false = 587 走 STARTTLS。 */
            @DefaultValue("false") boolean ssl
    ) {
    }

    /**
     * 积分计费。
     *
     * <p>三档单价的分工：{@code creditsPer1kInput} 便宜、{@code creditsPer1kOutput} 贵
     * —— 输入里大部分是可以复用的上下文，输出才是真正烧算力的部分，不区分单价等于
     * 鼓励用户把整个仓库贴进 prompt。
     *
     * <p>{@code holdCredits} 是「预扣」：一轮对话开始前先扣掉它，
     * 结束后按真实 token 结算、多退少补。没有预扣的话，余额只剩 1 分的账号
     * 也能发起一轮消耗 5 万 token 的对话，跑完才发现扣不动。
     */
    public record Credit(
            /** 注册赠送。给一个够跑几十轮的额度，让新用户先看到价值。 */
            @DefaultValue("300") long signupBonus,

            /** 每 1000 输入 token 消耗的积分。 */
            @DefaultValue("1") long creditsPer1kInput,

            /** 每 1000 输出 token 消耗的积分。 */
            @DefaultValue("3") long creditsPer1kOutput,

            /** 单轮最低消耗，避免「0.2 分」这种记不出来的账。 */
            @DefaultValue("1") long minChargePerTurn,

            /** 每轮预扣的积分数。 */
            @DefaultValue("30") long holdCredits,

            /** 余额低于该值就在前端提示充值。 */
            @DefaultValue("50") long lowBalanceThreshold,

            /** true = 余额为 0 时直接拒绝对话；false 则只提示不拦截（便于本地演示）。 */
            @DefaultValue("true") boolean enforceBalance
    ) {
    }
}
