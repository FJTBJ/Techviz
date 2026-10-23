#!/bin/bash
# 从站点证书的 AIA 字段抓取中间证书，补齐本地信任链
set -u
TMP=/tmp/hezi-leaf.pem
AIA=/tmp/hezi-inter.crt
BUNDLE=/opt/web3d/.ca-hezi.pem

echo | openssl s_client -connect git.hezi.com:443 -servername git.hezi.com -showcerts 2>/dev/null \
  | openssl x509 -outform PEM > "$TMP"

URL=$(openssl x509 -in "$TMP" -noout -text | awk '/CA Issuers/{print $NF; exit}' | sed 's/^URI://')
echo "AIA: $URL"

if [ -n "$URL" ]; then
  curl -sS -m 20 -o "$AIA" "$URL" && echo "downloaded $(wc -c < "$AIA") bytes"
  openssl x509 -in "$AIA" -inform DER -outform PEM -out /tmp/hezi-inter.pem 2>/dev/null \
    || cp "$AIA" /tmp/hezi-inter.pem
  openssl x509 -in /tmp/hezi-inter.pem -noout -subject -issuer
  cat /etc/ssl/certs/ca-certificates.crt /tmp/hezi-inter.pem > "$BUNDLE"
  echo "bundle: $(wc -c < "$BUNDLE") bytes"
fi

echo "=== verify ==="
curl -sS --cacert "$BUNDLE" -o /dev/null -w "http=%{http_code}\n" -m 10 https://git.hezi.com/ || echo "verify failed"
