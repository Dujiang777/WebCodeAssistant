# 服务器部署（腾讯云轻量 · Ubuntu 24.04 · 无 Docker）

线上实例：`139.199.88.15`（轻量应用服务器 `lhins-d32cso4p`，广州，2 vCPU / 2 GB / 50 GB SSD，已配 3.9 GB swap）

## 为什么走原生部署而不是 docker compose

`deploy/docker-compose.yml` 依然可用（本地/有 Docker 的机器），但这台机器上：

- **MySQL 8 + Redis 已经装好并在跑**（宿主机原生），再套一层容器纯属浪费；
- 只有 2 GB 内存。compose 里的后端镜像是**在容器里 gradle 构建**的，
  在 2 GB 机器上构建 Spring Boot + LangChain4j 大概率 OOM；
- 没装 Docker，也没必要为此多背一层运行时。

所以线上采用：**宿主机跑 MySQL/Redis/nginx，后端跑 systemd，前端由 nginx 托管静态产物。**

## 目录布局

```
/opt/wca/
├── app.jar                 后端可执行 jar（build.sh 产出）
├── dist/                   前端静态产物（nginx root）
├── workspaces/             WORKSPACE_ROOT —— 用户项目落盘处（备份对象）
├── maven-settings.xml      编译闭环用的 Maven 镜像配置
├── init.gradle             Gradle 依赖镜像（构建期用）
├── gradle-home/            构建期 Gradle 用户目录（内存上限写在这里）
├── wca.env                 ★ 唯一密钥载体，600 权限，不进 git
├── build.log               构建日志
└── src/                    从 Gitee 克隆的源码
```

## 首次部署

```bash
# 1) 拉源码（服务器直连 Gitee）
sudo git clone --depth 1 https://gitee.com/du-jiangjiang/web-code-assistant.git /opt/wca/src
cd /opt/wca/src

# 2) 构建（约 6~12 分钟，大头是下载依赖；日志 /opt/wca/build.log）
sudo bash deploy/server/build.sh          # 或 nohup bash deploy/server/build.sh &

# 3) 填环境变量（按 wca.env.example 抄一份，把 CHANGE_ME 全部换掉）
sudo cp deploy/server/wca.env.example /opt/wca/wca.env
sudo chmod 600 /opt/wca/wca.env
sudo vi /opt/wca/wca.env

# 4) 初始化数据库（一次即可，见下节）

# 5) 安装并启动（幂等，可重复执行）
sudo bash deploy/server/install.sh
```

## 数据库初始化（一次）

MySQL 8 是宿主机原生安装的。要建库 + 建一个专用账号：

```sql
CREATE DATABASE IF NOT EXISTS webcode
  DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER IF NOT EXISTS 'webcode'@'127.0.0.1' IDENTIFIED BY '<DB_PASSWORD>';
GRANT ALL PRIVILEGES ON webcode.* TO 'webcode'@'127.0.0.1';
FLUSH PRIVILEGES;
```

> 建表不用管：后端启动时 **Flyway 会自动跑 `src/main/resources/db/migration/V*.sql`**。
> 时区也已经在 `DB_URL` 里钉死为 `+08:00`（写成 `%2B08:00`），
> 否则 MySQL 默认 UTC，所有时间戳会整体差 8 小时。

## 日常发版

```bash
cd /opt/wca/src && sudo git pull
sudo bash deploy/server/build.sh          # 重新构建
sudo cp /opt/wca/app.jar /opt/wca/app.jar.bak   # 可选：留个回滚点
sudo systemctl restart wca-backend
```

前端产物是 nginx 直接读的静态文件，`build.sh` 已经把它铺到 `/opt/wca/dist`，无需重启 nginx。

## 运维速查

```bash
journalctl -u wca-backend -f          # 后端实时日志
systemctl status wca-backend          # 服务状态
curl -s http://127.0.0.1:8080/api/health   # 后端健康（含模型是否配置）
curl -sI http://127.0.0.1/            # nginx 是否在服务静态站点
free -m                               # 2G 机器，先看内存再决定加堆
```

**内存预算**（2 GB 物理 + 3.9 GB swap）：MySQL ≈ 500 MB、JVM 堆 640 MB
（`wca-backend.service` 里写死）、Redis ≈ 15 MB、nginx ≈ 15 MB。
想调大 JVM 之前先确认 `free -m` 的 available，否则会和 MySQL 互相触发 OOM Killer。

## 常见坑

1. **改动 `deploy/docker-compose.yml` 里的环境变量时，别忘了同步 `wca.env.example`** ——
   两份都是「环境变量样板」，只改一边会让部署和自检跑在不同配置上。
2. **`FRONTEND_BASE_URL` 不改**，用户收到的邮箱验证/重置链接会指向 localhost，点开就废。
3. **`ADMIN_USERNAMES` 建完首位管理员要清空**，否则这个名字永远是管理员。
4. **`LLM_EMBED_*` 留空 = 语义检索降级**（关键词检索仍可用）。DeepSeek 官方没有
   `/v1/embeddings`，要真语义检索得另接一家 embedding 服务。
5. **端口暴露**：后端 8080 只监听本机、由 nginx 反代；轻量服务器的防火墙
   （控制台「防火墙」页）只需放行 22 / 80（加 HTTPS 时再放行 443）。
