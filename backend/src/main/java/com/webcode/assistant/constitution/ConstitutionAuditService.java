package com.webcode.assistant.constitution;

import com.webcode.assistant.common.ApiException;
import com.webcode.assistant.common.ErrorCode;
import com.webcode.assistant.workspace.Workspace;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 宪章对账：把 {@code .wca/CONSTITUTION.md} 里的「禁止 / 不得 / MUST NOT」条款
 * 对到补丁的新增行和目标路径上。
 *
 * <p>宪法原先只进 prompt，模型可以装没看见。禁区管路径，宪章管<b>写了什么</b>。
 * 只认高把握的针：反引号里的字、{@code @注解}、以及条款里点名的路径片段。
 * 空泛的「要写注释」不拦人，避免误伤。
 */
@Service
public class ConstitutionAuditService {

    private static final Pattern FORBID = Pattern.compile(
            "禁止|不得|不要|严禁|永远不要|MUST\\s*NOT|must\\s*not");
    private static final Pattern TICK = Pattern.compile("`([^`]+)`");
    private static final Pattern ANNO = Pattern.compile("@[A-Za-z][A-Za-z0-9_]+");

    private final ConstitutionService constitutionService;

    public ConstitutionAuditService(ConstitutionService constitutionService) {
        this.constitutionService = constitutionService;
    }

    public Audit inspect(Workspace workspace, String filePath, String diff) {
        ConstitutionService.ConstitutionView view = constitutionService.read(workspace);
        if (!view.exists() || view.content() == null || view.content().isBlank()) {
            return new Audit(false, List.of(), false);
        }
        String added = addedLines(diff).toLowerCase(Locale.ROOT);
        String path = (filePath == null ? "" : filePath).toLowerCase(Locale.ROOT);
        List<Hit> hits = new ArrayList<>();
        boolean blocked = false;
        for (String clause : forbidClauses(view.content())) {
            for (String needle : needlesOf(clause)) {
                if (needle.length() < 3) continue;
                String key = needle.toLowerCase(Locale.ROOT);
                boolean inAdded = added.contains(key);
                boolean inPath = key.indexOf('/') >= 0 && path.contains(key);
                if (inAdded || inPath) {
                    hits.add(new Hit(clause, needle, true));
                    blocked = true;
                    break;
                }
            }
        }
        return new Audit(true, List.copyOf(hits), blocked);
    }

    public void assertClean(Workspace workspace, String filePath, String diff) {
        Audit audit = inspect(workspace, filePath, diff);
        if (!audit.blocked() || audit.hits().isEmpty()) {
            return;
        }
        Hit first = audit.hits().getFirst();
        throw new ApiException(ErrorCode.CHARTER_BLOCKED,
                "宪章禁止这项改动：「" + first.clause() + "」（命中 " + first.needle() + "）");
    }

    private static List<String> forbidClauses(String content) {
        List<String> out = new ArrayList<>();
        for (String raw : content.split("\\R")) {
            String line = raw.trim();
            if (line.startsWith("- ") || line.startsWith("* ")) {
                line = line.substring(2).trim();
            }
            if (line.isEmpty() || line.startsWith("#") || line.startsWith(">")) {
                continue;
            }
            if (FORBID.matcher(line).find()) {
                out.add(line);
            }
        }
        return out;
    }

    private static List<String> needlesOf(String clause) {
        List<String> out = new ArrayList<>();
        Matcher ticks = TICK.matcher(clause);
        while (ticks.find()) {
            String token = ticks.group(1).trim();
            if (!token.isEmpty()) out.add(token);
        }
        Matcher annos = ANNO.matcher(clause);
        while (annos.find()) {
            out.add(annos.group());
        }
        return out;
    }

    private static String addedLines(String diff) {
        if (diff == null || diff.isBlank()) {
            return "";
        }
        StringBuilder added = new StringBuilder();
        for (String line : diff.split("\\R", -1)) {
            if (line.startsWith("+") && !line.startsWith("+++")) {
                added.append(line).append('\n');
            }
        }
        return added.toString();
    }

    public record Hit(String clause, String needle, boolean violated) {
    }

    public record Audit(boolean present, List<Hit> hits, boolean blocked) {
    }
}
