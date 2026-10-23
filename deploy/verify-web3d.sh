#!/bin/bash
set -u
U=web3d
P=pEVYdSHhFWtu1qsT
B=https://web3d.sfjabs.cn

code() { curl -sS -o /dev/null -w '%{http_code}' "$@"; }

echo "dns        : $(getent hosts web3d.sfjabs.cn | awk '{print $1}' | head -n1)"
echo "no-auth    : $(code "$B/")"
echo "auth home  : $(code -u "$U:$P" "$B/") bytes=$(curl -sS -u "$U:$P" "$B/" | wc -c)"
echo "api/stages : $(code -u "$U:$P" "$B/api/stages")"
echo "api/scene  : $(code -u "$U:$P" "$B/api/scene")"
echo "api/me     : $(code -u "$U:$P" "$B/api/auth/me")"
echo "http->https: $(code "http://web3d.sfjabs.cn/")"
echo "leyo       : $(code https://leyo.sfjabs.cn/)"
echo "--- stages body ---"
curl -sS -u "$U:$P" "$B/api/stages" | head -c 400
echo
