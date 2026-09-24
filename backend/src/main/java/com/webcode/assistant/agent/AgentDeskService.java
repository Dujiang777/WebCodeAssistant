package com.webcode.assistant.agent;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Agent 工位（影子工作区）状态服务 —— 功能 13。
 *
 * <p><b>为什么需要它：</b>默认的对话界面只让人看到「打字机」（文本在流）和「事后话」（一条条工具卡），
 * 看不到 Agent 在工作区里的<b>行为</b>。这里把每次工具调用翻译成空间状态：
 * 它打开了哪些文件、光标停在哪个文件的哪一行、正在 grep 什么、草稿 diff 怎么长出来、
 * 刚才这一连串动作是什么顺序。前端只做「替换渲染」，不做推断 ——
 * 状态机只在这一个地方，多一处就是多一处能算错的地方。
 *
 * <p><b>存储：</b>内存 {@code Map<sessionId, Desk>}。工位是「此刻的样子」而不是历史事实，
 * 进程重启后重放历史工具事件就能重建（事件全在会话缓冲里），所以不落库。
 *
 * <p><b>事件：</b>每次状态变化推一条 {@code desk} 事件（整块快照），
 * 前端断线重连后拿到的第一条 desk 事件就把面板校正回来了。
 */
@Service
public class AgentDeskService {

    private static final Logger log = LoggerFactory.getLogger(AgentDeskService.class);

    /** 行为时间线保留条数（够看清「刚才那几步」即可，不追求完整历史）。 */
    private static final int MAX_ACTIVITY = 40;

    /** 工位上最多同时展示几张「摊开的文件」。 */
    private static final int MAX_OPEN_FILES = 8;

    private static final int MAX_DRAFTS = 12;

    private static final Pattern LINES_PATTERN = Pattern.compile("(\\d+)\\s*行");
    private static final Pattern HITS_PATTERN = Pattern.compile("(\\d+)\\s*处匹配");
    private static final Pattern STAT_PATTERN = Pattern.compile("\\+(\\d+)\\s*/\\s*-(\\d+)");

    private final ChatEventHub hub;
    private final Map<Long, Desk> desks = new ConcurrentHashMap<>();

    public AgentDeskService(ChatEventHub hub) {
        this.hub = hub;
    }

    // ------------------------------------------------------------ 写入端

    /** 工具调用开始：记录「正在干什么」，并推一次工位快照。 */
    public void toolStarted(long sessionId, String tool, Map<String, Object> args) {
        Desk desk = deskOf(sessionId);
        synchronized (desk) {
            desk.toolCalls++;
            desk.activeTool = tool;
            desk.activeStartedAt = Instant.now();
            desk.touch();

            String detail = describeStart(tool, args);
            desk.activeSummary = detail;
            String path = arg(args, "path");
            switch (tool) {
                case "read_file" -> {
                    desk.cursorFile = path;
                    desk.cursorLine = 1;
                    desk.putOpenFile(path, "read", null);
                }
                case "propose_patch" -> {
                    desk.cursorFile = arg(args, "file");
                    desk.putOpenFile(arg(args, "file"), "write", null);
                }
                case "grep" -> desk.grep = new GrepState(arg(args, "pattern"), scopeOf(args), arg(args, "glob"),
                        "running", null, Instant.now());
                case "list_dir" -> desk.lastDirectory = path == null || path.isBlank() ? "." : path;
                default -> {
                    // run_tests / spring_map / semantic_search：只体现在 phase 与时间线上
                }
            }
            desk.activity(tool, label(tool), "running", detail, Instant.now());
            publish(desk);
        }
    }

    /** 工具调用结束：补全结果（行数 / 命中数 / 状态），再推一次快照。 */
    public void toolFinished(long sessionId, String tool, boolean ok, String summary) {
        Desk desk = desks.get(sessionId);
        if (desk == null) {
            return;
        }
        synchronized (desk) {
            String text = summary == null ? "" : summary;
            switch (tool) {
                case "read_file" -> {
                    Integer lines = firstNumber(LINES_PATTERN, text);
                    if (desk.cursorFile != null) {
                        desk.putOpenFile(desk.cursorFile, "read", lines);
                        desk.cursorLine = 1;
                    }
                }
                case "grep" -> {
                    if (desk.grep != null) {
                        desk.grep = new GrepState(desk.grep.pattern(), desk.grep.scope(), desk.grep.glob(),
                                ok ? "done" : "failed", firstNumber(HITS_PATTERN, text), Instant.now());
                    }
                }
                case "propose_patch" -> {
                    // 草稿的行数统计由 draftProposed 提供更准确的值，这里只补状态
                }
                default -> {
                }
            }
            desk.activeTool = null;
            desk.activeSummary = null;
            desk.activeStartedAt = null;
            desk.completeLastActivity(ok, text);
            desk.touch();
            publish(desk);
        }
    }

    /**
     * 草稿 diff 落库后调用：草稿是工位上会「长大」的东西，
     * 前端据此渲染「草稿 +18 / -16」这类条。
     */
    public void draftProposed(long sessionId, String patchId, String file, int added, int removed) {
        Desk desk = deskOf(sessionId);
        synchronized (desk) {
            desk.drafts.addFirst(new DraftState(patchId, file, added, removed, "draft", Instant.now()));
            while (desk.drafts.size() > MAX_DRAFTS) {
                desk.drafts.removeLast();
            }
            desk.putOpenFile(file, "write", null);
            desk.cursorFile = file;
            desk.touch();
            publish(desk);
        }
    }

    /** 会话被清空 / 删除时丢掉工位状态。 */
    public void forget(long sessionId) {
        desks.remove(sessionId);
    }

    // ------------------------------------------------------------ 读取端

    public DeskView view(long sessionId) {
        Desk desk = deskOf(sessionId);
        synchronized (desk) {
            return desk.view();
        }
    }

    // ------------------------------------------------------------ 内部

    private Desk deskOf(long sessionId) {
        return desks.computeIfAbsent(sessionId, id -> new Desk(id));
    }

    private void publish(Desk desk) {
        try {
            hub.publisher(desk.sessionId).desk(desk.view().toMap());
        } catch (RuntimeException ex) {
            // 工位推送失败绝不该影响 Agent 回合本身
            log.debug("推送工位状态失败: {}", ex.getMessage());
        }
    }

    private static String arg(Map<String, Object> args, String key) {
        if (args == null) {
            return null;
        }
        Object value = args.get(key);
        if (value == null) {
            return null;
        }
        String text = String.valueOf(value);
        return text.isBlank() ? null : text;
    }

    private static String scopeOf(Map<String, Object> args) {
        String path = arg(args, "path");
        return path == null ? "." : path;
    }

    private static Integer firstNumber(Pattern pattern, String text) {
        if (text == null || text.isEmpty()) {
            return null;
        }
        Matcher matcher = pattern.matcher(text);
        return matcher.find() ? Integer.valueOf(matcher.group(1)) : null;
    }

    /** 工具阶段的中文名：工位面板顶部那条状态就靠它。 */
    static String phaseLabel(String tool) {
        if (tool == null) {
            return "待命";
        }
        return switch (tool) {
            case "read_file" -> "正在读文件";
            case "list_dir" -> "正在翻目录";
            case "grep" -> "正在检索关键字";
            case "propose_patch" -> "正在起草补丁";
            case "run_tests" -> "正在跑测试";
            case "spring_map" -> "正在扫 Spring 组件";
            case "semantic_search" -> "正在语义检索";
            default -> "正在工作";
        };
    }

    private static String label(String tool) {
        return switch (tool) {
            case "read_file" -> "打开文件";
            case "list_dir" -> "浏览目录";
            case "grep" -> "关键字检索";
            case "propose_patch" -> "起草补丁";
            case "run_tests" -> "运行测试";
            case "spring_map" -> "扫描组件";
            case "semantic_search" -> "语义检索";
            default -> tool;
        };
    }

    /** 时间线上「开始」那行的说明。 */
    private static String describeStart(String tool, Map<String, Object> args) {
        return switch (tool) {
            case "read_file" -> shortPath(arg(args, "path"));
            case "list_dir" -> shortPath(scopeOf(args));
            case "grep" -> "/" + nullToEmpty(arg(args, "pattern")) + "/ in " + shortPath(scopeOf(args));
            case "propose_patch" -> shortPath(arg(args, "file"));
            case "semantic_search" -> "「" + nullToEmpty(arg(args, "query")) + "」";
            default -> "";
        };
    }

    private static String nullToEmpty(String value) {
        return value == null ? "" : value;
    }

    private static String shortPath(String path) {
        if (path == null) {
            return "";
        }
        int index = path.lastIndexOf('/');
        return index < 0 ? path : path.substring(index + 1);
    }

    /** 单个会话的工位状态。所有访问都在 synchronized(desk) 内，内部用非线程安全集合更省心。 */
    private static final class Desk {

        private final long sessionId;
        private final List<OpenFile> openFiles = new ArrayList<>();
        private final Deque<DraftState> drafts = new ArrayDeque<>();
        private final Deque<ActivityView> timeline = new ArrayDeque<>();

        private String activeTool;
        private String activeSummary;
        private Instant activeStartedAt;
        private String cursorFile;
        private Integer cursorLine;
        private GrepState grep;
        private String lastDirectory;
        private int toolCalls;
        private Instant updatedAt = Instant.now();

        private Desk(long sessionId) {
            this.sessionId = sessionId;
        }

        private void touch() {
            updatedAt = Instant.now();
        }

        /** 重复打开同一文件时把它提到最前，行数取最新值。 */
        private void putOpenFile(String path, String mode, Integer lines) {
            if (path == null || path.isBlank()) {
                return;
            }
            openFiles.removeIf(file -> file.path().equals(path));
            openFiles.add(0, new OpenFile(path, mode, lines, Instant.now()));
            while (openFiles.size() > MAX_OPEN_FILES) {
                openFiles.remove(openFiles.size() - 1);
            }
        }

        private void activity(String tool, String label, String status, String summary, Instant at) {
            timeline.addFirst(new ActivityView(tool, label, status, summary, at.toString()));
            while (timeline.size() > MAX_ACTIVITY) {
                timeline.removeLast();
            }
        }

        /** 工具结束时把最近一条 running 改成终态（时间线里不该有永远在跑的行）。 */
        private void completeLastActivity(boolean ok, String summary) {
            ActivityView head = timeline.peekFirst();
            if (head == null || !"running".equals(head.status())) {
                return;
            }
            timeline.removeFirst();
            timeline.addFirst(new ActivityView(head.tool(), head.label(), ok ? "ok" : "failed",
                    summary == null || summary.isBlank() ? head.summary() : summary, head.at()));
        }

        private DeskView view() {
            return new DeskView(
                    sessionId,
                    activeTool == null ? "idle" : activeTool,
                    phaseLabel(activeTool),
                    activeTool,
                    activeTool == null ? null : (activeSummary == null ? phaseLabel(activeTool) : activeSummary),
                    cursorFile,
                    activeTool == null && cursorFile == null ? null : cursorLine,
                    List.copyOf(openFiles.stream()
                            .map(file -> new DeskView.OpenFileView(file.path(), file.mode(), file.lines(),
                                    file.at().toString()))
                            .toList()),
                    grep == null ? null
                            : new DeskView.GrepView(grep.pattern(), grep.scope(), grep.glob(), grep.state(),
                                    grep.hits(), grep.at().toString()),
                    List.copyOf(drafts.stream()
                            .map(draft -> new DeskView.DraftView(draft.patchId(), draft.file(), draft.added(),
                                    draft.removed(), draft.status(), draft.at().toString()))
                            .toList()),
                    List.copyOf(timeline),
                    toolCalls,
                    lastDirectory,
                    updatedAt.toString());
        }
    }

    private record OpenFile(String path, String mode, Integer lines, Instant at) {
    }

    private record DraftState(String patchId, String file, int added, int removed, String status, Instant at) {
    }

    private record GrepState(String pattern, String scope, String glob, String state, Integer hits, Instant at) {
    }

    /**
     * 工位的对外视图 —— 前端 {@code AgentDesk} 面板直接渲染这个结构。
     *
     * @param phase       机器可读的阶段（idle / read_file / grep / …），前端据此上色
     * @param phaseLabel  人话阶段名
     * @param activeTool  此刻正在跑的工具，null 表示空闲
     * @param cursorFile  光标所在文件（最近的读或写）
     * @param cursorLine  光标行号
     * @param openFiles   摊在桌上的文件（最近 8 个，最新的在前）
     * @param grep        最近一次关键字检索的状态（含运行中）
     * @param drafts      草稿 diff，最新的在前
     * @param timeline    行为时间线（最近 40 条）
     * @param toolCalls   本轮工具调用次数
     */
    public record DeskView(long sessionId, String phase, String phaseLabel, String activeTool,
                           String activeIntent, String cursorFile, Integer cursorLine,
                           List<OpenFileView> openFiles, GrepView grep, List<DraftView> drafts,
                           List<ActivityView> timeline, int toolCalls, String lastDirectory,
                           String updatedAt) {

        public record OpenFileView(String path, String mode, Integer lines, String at) {
        }

        public record GrepView(String pattern, String scope, String glob, String state, Integer hits, String at) {
        }

        public record DraftView(String patchId, String file, int added, int removed, String status, String at) {
        }

        public Map<String, Object> toMap() {
            Map<String, Object> map = new LinkedHashMap<>();
            map.put("sessionId", sessionId);
            map.put("phase", phase);
            map.put("phaseLabel", phaseLabel);
            map.put("activeTool", activeTool);
            map.put("activeIntent", activeIntent);
            map.put("cursorFile", cursorFile);
            map.put("cursorLine", cursorLine);
            map.put("openFiles", openFiles);
            map.put("grep", grep);
            map.put("drafts", drafts);
            map.put("timeline", timeline);
            map.put("toolCalls", toolCalls);
            map.put("lastDirectory", lastDirectory);
            map.put("updatedAt", updatedAt);
            return map;
        }
    }

    /** 行为时间线的一条（同时用于 SSE body，故独立成公共 record）。 */
    public record ActivityView(String tool, String label, String status, String summary, String at) {
    }
}
