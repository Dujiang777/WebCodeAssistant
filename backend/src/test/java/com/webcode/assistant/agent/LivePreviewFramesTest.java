package com.webcode.assistant.agent;

import com.webcode.assistant.workspace.diff.FilePatch;
import com.webcode.assistant.workspace.diff.UnifiedDiffParser;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class LivePreviewFramesTest {

    @Test
    void stepsOneHunkAtATime() {
        String before = "class Demo {\n    int a = 1;\n    int b = 2;\n}\n";
        String diff = """
                --- a/Demo.java
                +++ b/Demo.java
                @@ -1,2 +1,2 @@
                 class Demo {
                -    int a = 1;
                +    int a = 10;
                @@ -3,2 +3,2 @@
                -    int b = 2;
                +    int b = 20;
                 }
                """;
        FilePatch filePatch = UnifiedDiffParser.parse(diff, "Demo.java").getFirst();
        PatchService.LivePreview preview = PatchService.buildFrames(
                "p1", "Demo.java", "两处赋值", before, filePatch);

        assertEquals(3, preview.frames().size());
        assertEquals(before, preview.frames().get(0));
        assertTrue(preview.frames().get(1).contains("int a = 10;"));
        assertTrue(preview.frames().get(1).contains("int b = 2;"));
        assertTrue(preview.frames().get(2).contains("int a = 10;"));
        assertTrue(preview.frames().get(2).contains("int b = 20;"));
        assertEquals(2, preview.marks().size());
    }
}
