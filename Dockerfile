# Web3D 技术预演后端（Express + better-sqlite3）
#
# better-sqlite3 v13 要求 Node >= 22，且 npm 包内已自带各平台预编译产物
# （N-API，含 linuxmusl-x64），因此不需要任何编译工具链，也不需要拉 glibc 镜像。
# 基础镜像用本地已有的 node:22-alpine，npm 走国内镜像。
# --ignore-scripts：跳过 better-sqlite3 的 node-gyp rebuild（否则会因缺 Python 失败）
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --registry=https://registry.npmmirror.com
COPY server ./server
EXPOSE 8787
CMD ["node", "server/index.mjs"]
