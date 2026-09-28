package com.webcode.assistant.build;

/**
 * 一条编译器诊断。
 *
 * @param file     相对工作区根的路径（若不在工作区内则原样返回绝对路径）
 * @param line     行号，可能为 null（有些诊断只有文件没有行）
 * @param column   列号，可能为 null
 * @param message  编译器原文
 * @param severity error / warning
 */
public record CompileIssue(String file, Integer line, Integer column, String message, String severity) {
}
