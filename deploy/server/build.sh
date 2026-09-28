#!/bin/bash
# ---------------------------------------------------------------------------
# WCA 服务器端构建脚本（2C2G 轻量云，无 Docker）
#
#   bash deploy/server/build.sh          # 前台跑，日志同时写 /opt/wca/build.log
#   nohup bash deploy/server/build.sh &  # 后台跑（首跑约 6-12 分钟，大头在下载依赖）
#
# 产出（install.sh 会消费）：
#   /opt/wca/app.jar      后端可执行 jar
#   /opt/wca/dist/        前端静态产物（nginx 直接托管）
#
# 三个刻意的安排：
#   1. Gradle 发行版走腾讯云镜像、依赖走阿里云镜像 —— 国内的服务器直连
#      services.gradle.org / repo1.maven.org 会慢到无法接受（甚至超时）。
#   2. 内存上限压到 1100m：仓库里 gradle.properties 写的是 -Xmx2g，
#      而这台机器只有 2G 物理内存（虽有 4G swap），照抄必 OOM 或疯狂换页。
#   3. npm 走 npmmirror，理由同上。
# ---------------------------------------------------------------------------
set -u

SRC="${SRC:-/opt/wca/src}"
OUT=/opt/wca
LOG="$OUT/build.log"
GRADLE_HOME_DIR="$OUT/gradle-home"

mkdir -p "$OUT" "$GRADLE_HOME_DIR"
exec >> "$LOG" 2>&1

say() { echo "=== [$(date '+%H:%M:%S')] $* ==="; }

say "0/5 准备"
cp -f "$(dirname "$0")/init.gradle" "$OUT/init.gradle"
cp -f "$(dirname "$0")/gradle-user.properties" "$GRADLE_HOME_DIR/gradle.properties"

say "1/5 拉取源码（Gitee）"
rm -rf "$SRC"
git clone --depth 1 https://gitee.com/du-jiangjiang/web-code-assistant.git "$SRC" || { say "CLONE_FAILED"; exit 1; }
say "CLONE_OK"

say "2/5 构建前端（npm install + vite build）"
cd "$SRC/frontend" || exit 1
npm install --registry=https://registry.npmmirror.com --no-audit --no-fund || { say "NPM_INSTALL_FAILED"; exit 1; }
npm run build || { say "FE_BUILD_FAILED"; exit 1; }
say "FE_OK"

say "3/5 构建后端（gradle bootJar）"
cd "$SRC/backend" || exit 1
# Gradle 发行版换腾讯云镜像（130MB，直连官方源在国内常年超时）
sed -i 's|https://services.gradle.org/distributions/|https://mirrors.cloud.tencent.com/gradle/|' \
  gradle/wrapper/gradle-wrapper.properties
chmod +x gradlew
GRADLE_USER_HOME="$GRADLE_HOME_DIR" ./gradlew --no-daemon --console=plain \
  --init-script "$OUT/init.gradle" bootJar || { say "BE_BUILD_FAILED"; exit 1; }
say "BE_OK"

say "4/5 落产物"
cp build/libs/*.jar "$OUT/app.jar" || exit 1
rm -rf "$OUT/dist"
cp -r ../frontend/dist "$OUT/dist" || exit 1
ls -la "$OUT/app.jar"
du -sh "$OUT/dist"

say "5/5 ALL_DONE"
