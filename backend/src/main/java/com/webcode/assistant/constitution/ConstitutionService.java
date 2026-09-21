package com.webcode.assistant.constitution;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;
import com.webcode.assistant.workspace.Workspace;
import com.webcode.assistant.workspace.WorkspacePathResolver;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.time.Instant;

/**
 * 仓库宪法（Constitution）—— 用户为某个仓库写下的「最高优先级规则」。
 *
 * <p>与 {@code .coding-rules.md} 这类自动探测的规则文件不同，宪法有三条硬约束：
 * <ol>
 *   <li><b>位置固定</b>：永远是工作区根目录下的 {@code .wca/CONSTITUTION.md}，
 *       找得到就用，找不到就明确说「没有」，不会拿别的文件凑数；</li>
 *   <li><b>优先级最高</b>：它注入 system prompt 时排在项目画像之前，
 *       并在提示词里明确声明「与默认习惯冲突时以宪法为准」；</li>
 *   <li><b>只有用户能写</b>：Agent 没有任何工具可以修改它 —— 宪法要是能被 AI 悄悄改掉，
 *       就不再是宪法了。</li>
 * </ol>
 *
 * <p>路径解析走 {@link WorkspacePathResolver}，与文件读写的安全边界完全一致。
 */
@Service
public class ConstitutionService {

    private static final Logger log = LoggerFactory.getLogger(ConstitutionService.class);

    /** 宪法文件在工作区内的固定路径。 */
    public static final String CONSTITUTION_PATH = ".wca/CONSTITUTION.md";

    /** 内容上限：宪法是约束不是论文，64KB 足够写一整套规范。 */
    private static final int MAX_CHARS = 64_000;

    private final WorkspacePathResolver pathResolver;

    public ConstitutionService(WorkspacePathResolver pathResolver) {
        this.pathResolver = pathResolver;
    }

    /** 读取宪法；不存在返回 {@code exists=false}，读取失败按不存在处理并记日志。 */
    public ConstitutionView read(Workspace workspace) {
        Path file = constitutionFile(workspace);
        if (file == null || !Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) {
            return new ConstitutionView(false, null, null, 0L);
        }
        try {
            String text = Files.readString(file, StandardCharsets.UTF_8);
            long mtime = Files.getLastModifiedTime(file, LinkOption.NOFOLLOW_LINKS).toMillis();
            return new ConstitutionView(true, CONSTITUTION_PATH, text, mtime);
        } catch (IOException ex) {
            log.warn("读取仓库宪法失败 workspace={}: {}", workspace.name(), ex.getMessage());
            return new ConstitutionView(false, null, null, 0L);
        }
    }

    /** 保存宪法。空内容等同于删除（用户有权撤回宪法）。 */
    public ConstitutionView save(Workspace workspace, String content) {
        if (content == null) {
            content = "";
        }
        if (content.length() > MAX_CHARS) {
            throw new ApiException(ErrorCode.BAD_REQUEST,
                    "宪法内容过长（" + content.length() + " 字符，上限 " + MAX_CHARS + "）。"
                            + "宪法应该是明确的硬规则，不是设计文档。");
        }
        Path file = constitutionFile(workspace);
        if (file == null) {
            throw new ApiException(ErrorCode.INTERNAL_ERROR, "无法定位工作区根目录");
        }
        try {
            Files.createDirectories(file.getParent());
            Files.writeString(file, content, StandardCharsets.UTF_8);
        } catch (IOException ex) {
            log.warn("保存仓库宪法失败 workspace={}: {}", workspace.name(), ex.getMessage());
            throw new ApiException(ErrorCode.INTERNAL_ERROR, "宪法写入磁盘失败：" + ex.getMessage());
        }
        long mtime;
        try {
            mtime = Files.getLastModifiedTime(file, LinkOption.NOFOLLOW_LINKS).toMillis();
        } catch (IOException ex) {
            mtime = System.currentTimeMillis();
        }
        boolean empty = content.isBlank();
        return new ConstitutionView(!empty, empty ? null : CONSTITUTION_PATH,
                empty ? null : content, mtime);
    }

    /**
     * 给新用户的宪法模板。里面是占位符与示例条款 —— 用户应该删掉不适用的小节，
     * 留下的每一条都会真实约束 Agent 的行为，所以宁缺毋滥。
     */
    public String template(Workspace workspace) {
        String name = workspace == null ? "本项目" : workspace.name();
        return """
                # 仓库宪法（CONSTITUTION）

                > 本文件是 AI 助手在本仓库工作时的最高优先级规则。
                > 与任何默认习惯冲突时，以本文件为准。请删除不适用的小节，只保留真正要硬性约束的条款。

                ## 1. 目标与边界

                - 本仓库（%s）的定位：（一句话写清楚它是什么）
                - AI 只允许修改以下目录内的代码：`src/`
                - 以下目录/文件永远不要动：`.github/`、`deploy/`、数据库迁移脚本

                ## 2. 技术栈约束

                - 语言与版本：（例：Java 21，禁用 var 以外的实验性语法）
                - 框架约定：（例：统一用构造器注入，禁止字段 @Autowired）
                - 依赖策略：新增第三方依赖前必须先说明理由并等待确认

                ## 3. 代码风格

                - 命名：（例：Service 层方法用动词开头，禁止缩写）
                - 注释：公共 API 必须有 Javadoc；禁止遗留注释掉的代码
                - 单文件不超过 400 行，超出必须拆分

                ## 4. 测试要求

                - 任何行为变更必须附带或更新对应测试
                - 修复 bug 的补丁必须先有一个能复现该 bug 的失败测试

                ## 5. 禁止事项

                - 禁止引入新的 JDBC 裸 SQL，统一走 Repository
                - 禁止在 Controller 里写业务逻辑
                - 禁止修改既有公开方法的签名（先新增重载，标注 @Deprecated 过渡）
                """.formatted(name);
    }

    private Path constitutionFile(Workspace workspace) {
        try {
            Path root = pathResolver.rootOf(workspace.rootPath());
            return root.resolve(".wca").resolve("CONSTITUTION.md");
        } catch (RuntimeException ex) {
            return null;
        }
    }

    /**
     * @param exists    工作区里是否有生效的宪法
     * @param path      固定路径（不存在时为 null）
     * @param content   内容（不存在时为 null）
     * @param updatedAt 最后修改时间（epoch millis）
     */
    public record ConstitutionView(boolean exists, String path, String content, Long updatedAt) {

        /** 给前端的时间视图，避免每个调用点自己格式化。 */
        public String updatedAtIso() {
            return updatedAt == null ? null : Instant.ofEpochMilli(updatedAt).toString();
        }
    }
}
