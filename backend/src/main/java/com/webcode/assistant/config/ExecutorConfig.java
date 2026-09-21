package com.webcode.assistant.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * 线程模型：Agent 循环、克隆、搜索全部跑在虚拟线程上，不占用 Tomcat 工作线程。
 *
 * <p>第一期刻意不用 WebFlux —— Spring MVC + {@code SseEmitter} + 虚拟线程已经足够，
 * 且能让阻塞式的文件 IO、JGit、JDBC 调用保持「同步写法」的可读性。
 *
 * <p>两个执行器打包成一个 {@link AppExecutors} 记录再暴露，避免同类型 Bean 在注入点产生歧义。
 * 它实现 {@link AutoCloseable} 是为了让 Spring 在容器关闭时能优雅停掉这两个池 ——
 * 只写 {@code destroyMethod} 而不实现方法是拿不到销毁能力的（容器启动时就会直接报
 * "Invalid destruction signature"）。
 */
@Configuration
public class ExecutorConfig {

    @Bean
    public AppExecutors appExecutors() {
        return new AppExecutors(
                // Agent 对话循环：模型调用是阻塞 IO，虚拟线程最合适。
                Executors.newVirtualThreadPerTaskExecutor(),
                // 克隆 / 解压等重 IO：独立池，避免与对话互相排队。
                Executors.newVirtualThreadPerTaskExecutor());
    }

    public record AppExecutors(ExecutorService agent, ExecutorService workspace) implements AutoCloseable {

        @Override
        public void close() {
            shutdown(agent);
            shutdown(workspace);
        }

        /** 先礼后兵：给 5 秒让在途任务收尾，超时就强制中断。 */
        private static void shutdown(ExecutorService executor) {
            if (executor == null) {
                return;
            }
            executor.shutdown();
            try {
                if (!executor.awaitTermination(5, TimeUnit.SECONDS)) {
                    executor.shutdownNow();
                }
            } catch (InterruptedException ex) {
                executor.shutdownNow();
                Thread.currentThread().interrupt();
            }
        }
    }
}
