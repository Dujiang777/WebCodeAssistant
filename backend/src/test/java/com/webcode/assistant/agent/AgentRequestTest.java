package com.webcode.assistant.agent;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class AgentRequestTest {

    @Test
    void explainSelectionGoesDirect() {
        AgentRequest request = request(
                "解释一下选中的这段代码：它在做什么、有什么边界情况和风险。",
                "src/UserController.java",
                new AgentRequest.Selection(10, 20, "return user;"));
        assertThat(request.directAnswer()).isTrue();
    }

    @Test
    void rewriteUsesEditProfile() {
        AgentRequest request = request("把这个类改成构造器注入", "src/UserService.java", null);
        assertThat(request.directAnswer()).isFalse();
        assertThat(request.toolProfile()).isEqualTo(AgentRequest.ToolProfile.EDIT);
    }

    @Test
    void findUsagesUsesSearchProfile() {
        AgentRequest request = request(
                "选中的这段还在哪些地方被用到？列出调用方。",
                "src/UserController.java",
                new AgentRequest.Selection(10, 12, "save();"));
        assertThat(request.directAnswer()).isFalse();
        assertThat(request.toolProfile()).isEqualTo(AgentRequest.ToolProfile.SEARCH);
    }

    @Test
    void noOpenFileUsesFullProfile() {
        AgentRequest request = request("这个项目用了什么构建方式？", null, null);
        assertThat(request.toolProfile()).isEqualTo(AgentRequest.ToolProfile.FULL);
    }

    private static AgentRequest request(String content, String file, AgentRequest.Selection selection) {
        return new AgentRequest(1L, 1L, 1L, content, file, selection, "deliver", null);
    }
}
