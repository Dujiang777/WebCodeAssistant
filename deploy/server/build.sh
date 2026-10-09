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
# Gradle 发行版换腾讯云镜像。两个坑：
#   ① 官方源（services.gradle.org）在国内服务器上实测 ~20 KB/s，130MB 要跑近两小时；
#   ② wrapper 文件里写的是 `https\://`（转义冒号），所以模式里**不能带 `https://` 前缀**，
#      否则静默不匹配、白等一场（2026-09-28 踩过）。
sed -i 's|services.gradle.org/distributions|mirrors.cloud.tencent.com/gradle|' \
  gradle/wrapper/gradle-wrapper.properties
grep -q 'mirrors.cloud.tencent.com/gradle' gradle/wrapper/gradle-wrapper.properties \
  || { say "MIRROR_PATCH_FAILED"; exit 1; }
chmod +x gradlew
GRADLE_USER_HOME="$GRADLE_HOME_DIR" ./gradlew --no-daemon --console=plain \
  --init-script "$OUT/init.gradle" bootJar || { say "BE_BUILD_FAILED"; exit 1; }
say "BE_OK"

say "4/6 落产物（原子替换，别原地 cp —— 旧进程还开着这个文件，"
say "    原地覆盖会让它懒加载时读到错位的 zip 内容 → NoClassDefFoundError）"
install -m 644 build/libs/*.jar "$OUT/app.jar.new" || exit 1
mv -f "$OUT/app.jar.new" "$OUT/app.jar" || exit 1
rm -rf "$OUT/dist"
cp -r ../frontend/dist "$OUT/dist" || exit 1
ls -la "$OUT/app.jar"
du -sh "$OUT/dist"

say "5/6 重启后端并等健康"
systemctl restart wca-backend || { say "RESTART_FAILED"; exit 1; }
for i in $(seq 1 30); do
  sleep 2
  CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/api/auth/me || true)
  if [ "$CODE" != "000" ]; then say "HEALTH_OK http=$CODE after ${i}x2s"; break; fi
done
if [ "$CODE" = "000" ]; then say "HEALTH_TIMEOUT"; exit 1; fi
systemctl is-active wca-backend

say "6/6 ALL_DONE"
