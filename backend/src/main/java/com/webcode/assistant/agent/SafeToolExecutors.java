package com.webcode.assistant.agent;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.langchain4j.agent.tool.Tool;
import dev.langchain4j.agent.tool.ToolExecutionRequest;
import dev.langchain4j.agent.tool.ToolSpecification;
import dev.langchain4j.agent.tool.ToolSpecifications;
import dev.langchain4j.service.tool.DefaultToolExecutor;
import dev.langchain4j.service.tool.ToolExecutor;

import java.lang.reflect.Method;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/**
 * 工具执行安全壳：把「参数 JSON 解析失败」从致命异常降级为可恢复的工具结果。
 *
 * <p><b>为什么要存在：</b>LangChain4j 的 {@link DefaultToolExecutor} 只兜「工具方法体内
 * 抛出的异常」——那会被作为失败结果喂回模型（见 {@code AgentToolbox} 各工具的异常约定）。
 * 但参数 JSON 的解析发生在它的 try 之外：模型偶尔吐出坏 JSON（流式拼接截断、字符串里
 * 混入未转义内容等，2026-10-09 线上实录 DeepSeek 在第 793 列混入了裸的「乱」字），
 * 解析异常会一路穿透到 SSE 关闭回调，被 langchain4j 的 {@code ignoringExceptions}
 * <b>静默吞掉</b>——工具没执行、循环不继续、onError 不触发，前端就永远停在
 * 「模型正在思考…」。
 *
 * <p><b>怎么修：</b>不再让框架从 {@code @Tool} 注解自动生成执行器，而是自己构建
 * {@code Map<ToolSpecification, ToolExecutor>}（{@code AiServices.tools(Map)} 重载），
 * 每个执行器先自己解析一遍参数：坏 JSON 不抛出，而是作为工具失败结果喂回模型，
 * 让它修正后重试——回合继续活着，最多消耗一点 token，而不是无声挂死。
 */
final class SafeToolExecutors {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final TypeReference<Map<String, Object>> ARGS = new TypeReference<>() { };

    private SafeToolExecutors() {
    }

    /** 扫描工具对象上的全部 {@code @Tool} 方法，产出带坏 JSON 兜底的执行器表。 */
    static Map<ToolSpecification, ToolExecutor> of(Object toolbox) {
        return of(toolbox, null);
    }

    /**
     * @param allow 非空时只注册这些工具名。解释/单文件改/查引用不该把 set_plan 全部塞给模型。
     */
    static Map<ToolSpecification, ToolExecutor> of(Object toolbox, Set<String> allow) {
        Map<ToolSpecification, ToolExecutor> map = new LinkedHashMap<>();
        for (Class<?> type = toolbox.getClass(); type != null && type != Object.class;
                type = type.getSuperclass()) {
            for (Method method : type.getDeclaredMethods()) {
                if (method.isSynthetic() || !method.isAnnotationPresent(Tool.class)) {
                    continue;
                }
                Tool specAnno = method.getAnnotation(Tool.class);
                String name = specAnno.name() == null || specAnno.name().isBlank()
                        ? method.getName() : specAnno.name();
                if (allow != null && !allow.contains(name)) {
                    continue;
                }
                ToolSpecification spec = ToolSpecifications.toolSpecificationFrom(method);
                if (map.containsKey(spec)) {
                    continue;
                }
                ToolExecutor delegate = new DefaultToolExecutor(toolbox, method);
                map.put(spec, (ToolExecutionRequest request, Object memoryId) ->
                        executeSafely(delegate, request, memoryId));
            }
        }
        return map;
    }

    private static String executeSafely(ToolExecutor delegate, ToolExecutionRequest request,
                                        Object memoryId) {
        String arguments = request.arguments();
        if (arguments != null && !arguments.isBlank()) {
            try {
                MAPPER.readValue(arguments, ARGS);
            } catch (Exception ex) {
                return "工具调用失败：参数不是合法 JSON（" + ex.getMessage()
                        + "）。请修正后重新调用该工具；字符串值必须用双引号包裹并正确转义。";
            }
        }
        return delegate.execute(request, memoryId);
    }
}
