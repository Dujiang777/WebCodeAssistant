package com.webcode.assistant.agent;

/**
 * 用户主动停止本轮时，工具边界上抛出的取消信号。
 *
 * <p>LangChain4j 没有暴露「中途终止回合」的 API，但每个工具方法体是我们的代码 ——
 * {@link AgentToolbox#guard} 在每个工具开始前检查取消标志，命中就抛出本异常。
 * 它必须穿透 guard 自己的异常翻译（否则会被当成普通的「工具失败」文本还给模型），
 * 一路传播到框架，最终落进 {@code TokenStream.onError}，由编排层识别为「用户停止」，
 * 走保留部分回答 + 退还预扣的收尾，而不是「回合失败」。
 */
public class TurnCanceledException extends RuntimeException {

    public TurnCanceledException() {
        super("用户停止了本轮对话");
    }
}
