package com.webcode.assistant.context;

import java.util.List;

/**
 * 项目画像 —— 送给模型的第一段「项目基本信息」。
 *
 * @param projectName      工作区名字
 * @param primaryLanguage  探测到的主语言标签（如 {@code Java}）
 * @param buildSystem      构建系统标签（如 {@code Maven (pom.xml)}），未识别为 null
 * @param buildFileExcerpt 构建文件开头片段，让模型知道依赖与 JDK 版本
 * @param readmeExcerpt    README 开头片段，通常含运行方式与项目约定
 * @param ruleFileName     命中的规则文件名，未命中为 null
 * @param ruleFileContent  规则文件内容（截断）
 * @param topLevelEntries  顶层条目，用于「先给模型一张地图」
 */
public record ProjectSummary(
        String projectName,
        String primaryLanguage,
        String buildSystem,
        String buildFileExcerpt,
        String readmeExcerpt,
        String ruleFileName,
        String ruleFileContent,
        List<String> topLevelEntries
) {
}
