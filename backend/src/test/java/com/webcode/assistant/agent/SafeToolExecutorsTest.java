package com.webcode.assistant.agent;

import dev.langchain4j.agent.tool.Tool;
import dev.langchain4j.agent.tool.ToolSpecification;
import dev.langchain4j.agent.tool.ToolExecutionRequest;
import dev.langchain4j.service.tool.ToolExecutor;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 回归：模型吐出坏 JSON 工具参数时，必须「喂回错误文本让模型重试」，
 * 而不是抛异常穿透到 SSE 关闭回调被静默吞掉（线上 2026-10-09 实录：
 * DeepSeek 参数在第 793 列混入裸字符，前端永远「正在思考」）。
 */
class SafeToolExecutorsTest {

    static class Box {
        @Tool(name = "read_file", value = "读文件")
        public String readFile(String path) {
            return "ok:" + path;
        }

        @Tool(name = "set_plan", value = "计划")
        public String setPlan() {
            return "plan-ok";
        }
    }

    private final Map<ToolSpecification, ToolExecutor> tools = SafeToolExecutors.of(new Box());

    private String call(String name, String arguments) {
        ToolSpecification spec = tools.keySet().stream()
                .filter(s -> s.name().equals(name))
                .findFirst()
                .orElseThrow();
        return tools.get(spec).execute(
                ToolExecutionRequest.builder().name(name).arguments(arguments).build(), null);
    }

    @Test
    void 扫描到全部工具() {
        assertThat(tools).hasSize(2);
        assertThat(tools.keySet()).extracting(ToolSpecification::name)
                .containsExactlyInAnyOrder("read_file", "set_plan");
    }

    @Test
    void 可以按名字收窄工具() {
        var filtered = SafeToolExecutors.of(new Box(), java.util.Set.of("read_file"));
        assertThat(filtered.keySet()).extracting(ToolSpecification::name)
                .containsExactly("read_file");
    }

    @Test
    void 合法参数正常执行() {
        assertThat(call("read_file", "{\"path\":\"src/Main.java\"}")).isEqualTo("ok:src/Main.java");
    }

    @Test
    void 空参数直接透传() {
        assertThat(call("set_plan", null)).isEqualTo("plan-ok");
        assertThat(call("set_plan", "")).isEqualTo("plan-ok");
    }

    @Test
    void 坏JSON不抛异常而是喂回错误文本() {
        // 线上实录同款形态：合法对象中途混入裸 CJK 字符
        String result = call("read_file", "{\"path\":\"src\"乱…}");
        assertThat(result).contains("工具调用失败").contains("JSON");
        // 混入未转义换行 / 截断，同样兜住
        assertThat(call("read_file", "{\"path\":\"a\nb\"}")).contains("工具调用失败");
        assertThat(call("read_file", "{\"path\":")).contains("工具调用失败");
    }

    @Test
    void 错误文本明确指导模型重试() {
        String result = call("read_file", "{bad");
        assertThat(result).contains("重新调用");
    }
}
