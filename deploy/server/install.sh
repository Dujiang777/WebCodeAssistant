#!/bin/bash
# ---------------------------------------------------------------------------
# WCA 一键安装（幂等，可重复执行）：装依赖 → 建目录 → 配 nginx → 装 systemd
#
#   bash /opt/wca/src/deploy/server/install.sh
#
# 前提：先跑过 build.sh（需要 /opt/wca/app.jar 与 /opt/wca/dist），
#       并在 /opt/wca/wca.env 里填好密钥（脚本会在缺失时从 example 生成一份）。
#
# 不在这里做的事：建数据库、建库用户 —— 那需要 MySQL 的 root 凭据，
# 交给人或走 SSH 做（见 README 的「数据库初始化」）。
# ---------------------------------------------------------------------------
set -u
OUT=/opt/wca
SELF="$(cd "$(dirname "$0")" && pwd)"

echo "=== 1/6 安装系统依赖（nginx / maven）"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx maven

echo "=== 2/6 建运行用户与目录"
id -u wca >/dev/null 2>&1 || useradd -r -m -s /bin/bash wca
mkdir -p "$OUT/workspaces" "$OUT/logs"
cp -f "$SELF/maven-settings.xml" "$OUT/maven-settings.xml"

if [ ! -f "$OUT/wca.env" ]; then
  cp "$SELF/wca.env.example" "$OUT/wca.env"
  chmod 600 "$OUT/wca.env"
  echo ">>> 已生成 $OUT/wca.env，记得把里面所有 CHANGE_ME 换掉"
fi

echo "=== 3/6 校验构建产物"
[ -f "$OUT/app.jar" ] || echo "!! 缺 $OUT/app.jar —— 先执行 deploy/server/build.sh"
[ -d "$OUT/dist" ]    || echo "!! 缺 $OUT/dist ——  先执行 deploy/server/build.sh"

echo "=== 4/6 配置 nginx 站点"
cp -f "$SELF/nginx-wca.conf" /etc/nginx/sites-available/wca.conf
ln -sf /etc/nginx/sites-available/wca.conf /etc/nginx/sites-enabled/wca.conf
rm -f /etc/nginx/sites-enabled/default
if nginx -t; then
  systemctl enable nginx >/dev/null 2>&1
  systemctl reload nginx || systemctl restart nginx
  echo ">>> nginx 已就绪（8081 端口）"
else
  echo "!! nginx 配置校验失败，请检查上面输出"
fi

echo "=== 5/6 权限收敛"
chown -R wca:wca "$OUT"
chmod 600 "$OUT/wca.env"

echo "=== 6/6 安装并启动后端服务"
cp -f "$SELF/wca-backend.service" /etc/systemd/system/wca-backend.service
systemctl daemon-reload
systemctl enable wca-backend >/dev/null 2>&1
systemctl restart wca-backend
sleep 4
systemctl --no-pager --lines=6 status wca-backend || true

echo
echo "=== DONE ==="
echo "看日志： journalctl -u wca-backend -f"
echo "健康检查：curl -s http://127.0.0.1:8080/api/health"
echo "站点： http://139.199.88.15:8081"
