package com.webcode.assistant.agent;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class ChatDiffSalvageTest {

    @Test
    void extractsFencedDiffAndKeepsTheProse() {
        String raw = """
                把冒泡排序扩成可升降序。
                ```diff
                --- a/src/BubbleSort.java
                +++ b/src/BubbleSort.java
                @@ -1,1 +1,1 @@
                -old
                +new
                ```
                """;
        assertThat(ChatDiffSalvage.extract(raw)).contains("@@ -1,1 +1,1 @@");
        assertThat(ChatDiffSalvage.strip(raw)).isEqualTo("把冒泡排序扩成可升降序。");
    }

    @Test
    void ignoresOrdinaryCodeFence() {
        String raw = """
                用法如下：
                ```java
                sort(arr);
                ```
                """;
        assertThat(ChatDiffSalvage.extract(raw)).isNull();
        assertThat(ChatDiffSalvage.strip(raw)).contains("sort(arr);");
    }
}
