# Web3D 技术预演（Express + better-sqlite3 + React/Vite 前端）
#
# 多阶段构建：
#   1) builder 阶段：安装全量依赖（含 vite/typescript 等开发依赖），构建前端 dist
#   2) 运行阶段：仅装生产依赖 + 拷贝 dist 与 server，镜像更小
#
# better-sqlite3 v13 要求 Node >= 22，npm 包内已自带各平台预编译产物
# （N-API，含 linuxmusl-x64），因此不需要任何编译工具链，也不需要拉 glibc 镜像。
# --ignore-scripts：跳过 better-sqlite3 的 node-gyp rebuild（否则会因缺 Python 失败）
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --registry=https://registry.npmmirror.com
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --registry=https://registry.npmmirror.com
COPY --from=builder /app/dist ./dist
COPY server ./server
EXPOSE 8787
CMD ["node", "server/index.mjs"]
