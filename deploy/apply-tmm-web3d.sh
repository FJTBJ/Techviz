#!/bin/bash
set -eu
CONF=/opt/tmm/deploy/nginx/default.conf
COMPOSE=/opt/tmm/docker-compose.yml

cp "$CONF" "$CONF.bak-$(date +%Y%m%d-%H%M%S)"

# 80 端口 server_name 加入新域名，便于 HTTP -> HTTPS 跳转
sed -i 's/server_name sfjabs.cn www.sfjabs.cn leyo.sfjabs.cn leyo.sfangjie.cn;/server_name sfjabs.cn www.sfjabs.cn leyo.sfjabs.cn leyo.sfangjie.cn web3d.sfjabs.cn;/' "$CONF"

# 追加 443 vhost（幂等：已存在则跳过）
if ! grep -q 'server_name web3d.sfjabs.cn;' "$CONF"; then
  echo "" >> "$CONF"
  cat /tmp/web3d-server.conf >> "$CONF"
fi

# tmm-nginx 挂载 auth 目录（幂等）
if ! grep -q 'deploy/nginx/auth:/etc/nginx/auth:ro' "$COMPOSE"; then
  sed -i '\|\./deploy/nginx/acme:/var/www/acme:ro|a\      - ./deploy/nginx/auth:/etc/nginx/auth:ro' "$COMPOSE"
fi

grep -n 'server_name sfjabs' "$CONF" || true
grep -n 'nginx/auth' "$COMPOSE" || true
