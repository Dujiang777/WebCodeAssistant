package com.webcode.assistant.semantic;

import java.util.List;

/**
 * 语义检索结果条目。
 *
 * @param path      文件相对路径
 * @param startLine 起始行（1-based）
 * @param endLine   结束行
 * @param content   代码块内容
 * @param score     余弦相似度（-1 ~ 1，越大越相关）
 */
public record SemanticHit(String path, int startLine, int endLine, String content, double score) {

    /** 检索状态。 */
    public static final String OK = "ok";
    public static final String NOT_INDEXED = "not_indexed";
    public static final String UNAVAILABLE = "unavailable";

    /** 语义检索响应。 */
    public record Result(String status, String note, int chunkCount, List<SemanticHit> hits) {
    }
}
