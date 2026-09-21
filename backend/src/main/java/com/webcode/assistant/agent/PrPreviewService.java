package com.webcode.assistant.agent;

import com.webcode.assistant.api.ApiModels;
import com.webcode.assistant.constitution.ConstitutionService;
import com.webcode.assistant.workspace.Workspace;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * 变更预演 PR —— 回答一个补丁确认前用户心里真正的问题：
 * <b>「假如这是一次真实的团队协作，这个 PR 会被怎么描述、审查者会揪住什么？」</b>
 *
 * <p>它不做任何新分析：标题、正文、清单全部由已有事实拼装而成 ——
 * 影响面来自 {@link BlastRadiusService}，宪法状态来自 {@link ConstitutionService}，
 * 行数统计来自 diff 本身。预演的价值不在「算出新东西」，
 * 而在把散落的证据组织成审查者看 PR 的那种视角。
 */
@Service
public class PrPreviewService {

    private static final Logger log = LoggerFactory.getLogger(PrPreviewService.class);

    private final BlastRadiusService blastRadiusService;
    private final ConstitutionService constitutionService;

    public PrPreviewService(BlastRadiusService blastRadiusService,
                            ConstitutionService constitutionService) {
        this.blastRadiusService = blastRadiusService;
        this.constitutionService = constitutionService;
    }

    public ApiModels.PrPreviewView build(Workspace workspace, Patch patch) {
        BlastRadius radius;
        try {
            radius = blastRadiusService.compute(workspace, patch.filePath(), patch.diffText());
        } catch (RuntimeException ex) {
            log.debug("PR 预演：影响面分析失败 {}", ex.getMessage());
            radius = null;
        }

        int added = radius == null ? 0 : radius.addedLines();
        int removed = radius == null ? 0 : radius.removedLines();

        String subject = radius != null && radius.declaredType() != null
                ? radius.declaredType()
                : simpleName(patch.filePath());
        String prefix = guessPrefix(patch, radius);
        String title = prefix + ": 变更 " + subject + "（+" + added + " / -" + removed + "）";
        String branch = prefix + "/" + slug(subject);

        String body = buildBody(patch, radius);
        List<ApiModels.PrCheckItem> checklist = buildChecklist(workspace, radius);
        ApiModels.PrPreviewView.Stats stats = new ApiModels.PrPreviewView.Stats(
                1, added, removed,
                radius == null ? 0 : radius.callers().size(),
                radius == null ? 0 : radius.tests().size());

        return new ApiModels.PrPreviewView(patch.id().toString(), title, branch, body, stats, checklist);
    }

    // ------------------------------------------------------------ 内部实现

    private String buildBody(Patch patch, BlastRadius radius) {
        StringBuilder sb = new StringBuilder();
        sb.append("## 变更内容\n\n`").append(patch.filePath()).append("`");
        if (radius != null && radius.declaredType() != null) {
            sb.append("（").append(radius.declaredType()).append("）");
        }
        sb.append("\n\n");

        if (radius != null) {
            if (!radius.changedMembers().isEmpty()) {
                sb.append("触碰成员：").append(String.join("、", radius.changedMembers())).append("\n\n");
            }
            sb.append("## 影响面\n\n").append(radius.headline()).append("\n\n");
            if (!radius.callers().isEmpty()) {
                sb.append("引用位置：\n\n");
                for (BlastRadius.Ref ref : radius.callers()) {
                    sb.append("- `").append(ref.file()).append(':').append(ref.line()).append("`\n");
                }
                sb.append('\n');
            }
            if (!radius.risks().isEmpty()) {
                sb.append("## 风险\n\n");
                for (BlastRadius.Risk risk : radius.risks()) {
                    sb.append("- **[").append(risk.level()).append("]** ").append(risk.label())
                            .append(" —— ").append(risk.reason()).append('\n');
                }
                sb.append('\n');
            }
        } else {
            sb.append("## 影响面\n\n影响面分析未能完成，请在应用后跑一次编译验证。\n\n");
        }
        sb.append("## 建议验证\n\n");
        sb.append("1. 应用补丁后运行编译验证（应用卡片会自动触发）；\n");
        if (radius != null && !radius.tests().isEmpty()) {
            sb.append("2. 运行相关测试：");
            for (BlastRadius.Ref ref : radius.tests()) {
                sb.append('`').append(ref.file()).append("` ");
            }
            sb.append('\n');
        } else {
            sb.append("2. 该变更暂无测试引用，建议补充用例；\n");
        }
        sb.append("3. 在编辑器里确认 diff 与预期一致后再合并。");
        return sb.toString();
    }

    private List<ApiModels.PrCheckItem> buildChecklist(Workspace workspace, BlastRadius radius) {
        List<ApiModels.PrCheckItem> items = new ArrayList<>();
        if (radius != null) {
            for (BlastRadius.Risk risk : radius.risks()) {
                String state = BlastRadius.LEVEL_HIGH.equals(risk.level()) ? "bad"
                        : BlastRadius.LEVEL_MEDIUM.equals(risk.level()) ? "warn" : "info";
                items.add(new ApiModels.PrCheckItem(risk.label(), state, risk.reason()));
            }
            items.add(radius.tests().isEmpty()
                    ? new ApiModels.PrCheckItem("测试覆盖", "warn",
                            "没有测试引用被改类型，行为回归只能靠人工确认")
                    : new ApiModels.PrCheckItem("测试覆盖", "ok",
                            radius.tests().size() + " 个测试文件引用该类型，可运行验证"));
            items.add(radius.callers().isEmpty()
                    ? new ApiModels.PrCheckItem("调用方影响", "ok", "未发现工作区内其他调用方")
                    : new ApiModels.PrCheckItem("调用方影响", "warn",
                            radius.callers().size() + " 处引用，应用后编译验证会暴露签名冲突"));
        } else {
            items.add(new ApiModels.PrCheckItem("影响面分析", "warn", "未能完成，请谨慎应用"));
        }

        ConstitutionService.ConstitutionView constitution = constitutionService.read(workspace);
        items.add(constitution.exists()
                ? new ApiModels.PrCheckItem("仓库宪法", "ok",
                        "已配置 —— Agent 生成补丁时受宪法约束，请人工复核关键条款")
                : new ApiModels.PrCheckItem("仓库宪法", "info",
                        "未配置宪法，无法校验团队规范；可在顶栏「宪法」中定义"));
        return items;
    }

    /** 按补丁特征猜一个约定式前缀，只是命名建议，用户可随意改。 */
    private static String guessPrefix(Patch patch, BlastRadius radius) {
        String file = patch.filePath().toLowerCase(Locale.ROOT);
        if (file.endsWith(".sql") || file.contains("migration") || file.contains("flyway")) {
            return "db";
        }
        if (file.contains("test")) {
            return "test";
        }
        if (file.contains("fix") || radius != null && radius.risks().stream()
                .anyMatch(risk -> BlastRadius.LEVEL_HIGH.equals(risk.level()))) {
            return "fix";
        }
        if (file.contains("doc") || file.endsWith(".md")) {
            return "docs";
        }
        return "patch";
    }

    private static String simpleName(String path) {
        int slash = path.lastIndexOf('/');
        return slash >= 0 ? path.substring(slash + 1) : path;
    }

    private static String slug(String value) {
        String cleaned = value.replaceAll("[^\\w\\u4e00-\\u9fa5]+", "-").toLowerCase(Locale.ROOT);
        while (cleaned.startsWith("-")) {
            cleaned = cleaned.substring(1);
        }
        while (cleaned.endsWith("-")) {
            cleaned = cleaned.substring(0, cleaned.length() - 1);
        }
        return cleaned.isEmpty() ? "change" : cleaned;
    }
}
