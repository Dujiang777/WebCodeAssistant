# V2 沙箱设计（当前未实现）

这个目录预留给 V2 的「每用户 Docker 沙箱」。**MVP 刻意不实现它**，这份文档说明为什么、
以及将来落地时需要满足哪些约束。

## 为什么 V1 不做

V1 的工具集里**没有任何能执行命令的能力**（只有 `list_dir` / `read_file` / `grep` / `propose_patch`），
所以「在容器里跑代码」并不必要；而把它做出来会立刻引入一整套新问题：

- 用户代码本质是不可信代码，跑起来就需要 cgroup / 内存 / CPU / 网络 / pid 隔离；
- 需要把沙箱生命周期与工作区绑定，处理泄漏与并发上限；
- 需要对齐「文件在宿主机、执行在容器」两条路径（bind mount 权限、uid 映射）。

在一个还没有 `run_command` 的产品里，这些复杂度全是纯负债。

## V2 落地时的镜像

```dockerfile
# sandbox/Dockerfile —— 每用户一个长驻容器，不是每次执行新建
FROM eclipse-temurin:21-jdk-jammy

# 只装最基础的构建工具；不要装任何联网客户端
RUN apt-get update && apt-get install -y --no-install-recommends \
      git maven ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 非 root 运行
RUN useradd -m -u 10001 sandbox
USER sandbox
WORKDIR /workspace
```

## 运行时约束

| 约束 | 做法 |
| --- | --- |
| 工作区隔离 | `--mount type=bind,src=<workspace>,dst=/workspace`（默认只读，写操作仍走后端） |
| 资源上限 | `--memory 2g --memory-swap 2g --cpus 2 --pids-limit 256` |
| 无网络 | `--network none`（需要依赖时预先装进镜像层） |
| 无特权 | `--cap-drop ALL --security-opt no-new-privileges` |
| 执行超时 | 后端对每次 `run_command` 设硬超时（默认 30s），到点 `docker kill` |
| 输出上限 | 截断后再回给模型，避免一次 `cat` 撑爆上下文 |
| 清理 | 容器空闲 TTL + 启动时回收孤儿容器 |

## 后端需要新增的抽象

1. `SandboxProvider` 接口 + `DockerSandboxProvider` 实现；
   `LocalSandboxProvider`（**直接拒绝所有命令**）作为未启用沙箱时的默认实现 ——
   让「没有沙箱」成为一个显式状态，而不是静默放行。
2. `run_command` 工具：参数只有 `command` 与 `timeoutSeconds`；
   **依然不写盘**，改文件仍然只能通过 `propose_patch`。
3. xterm.js 做交互式终端：SSE 是单向的，终端需要 WebSocket，
   所以届时要把 `ChatEventPublisher` 的事件通道换成双向实现
   （接口层已经为此做了隔离，见 `agent/ChatEventPublisher.java`）。
