#!/bin/bash
# Web3D 站点证书部署 hook：签发/续期后同步进 tmm-nginx 挂载目录并 reload
set -eu
DST=/opt/tmm/deploy/nginx/certs
SRC=/etc/letsencrypt/live/web3d.sfjabs.cn
cp -L "$SRC/fullchain.pem" "$DST/web3d-fullchain.pem"
cp -L "$SRC/privkey.pem"   "$DST/web3d-privkey.pem"
chmod 644 "$DST/web3d-fullchain.pem"
chmod 600 "$DST/web3d-privkey.pem"
docker exec tmm-nginx nginx -s reload || true
