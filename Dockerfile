# =====================================================================
# Home Media Platform —— 多阶段交付镜像(T015;research D10,amd64/arm64)
#
# base    :node:24-bookworm-slim(原生模块兼容基线)
# builder :python3/make/g++ 仅装本阶段(better-sqlite3 等原生依赖
#          预编译二进制不可用时回退源码编译);corepack 激活 pnpm →
#          pnpm fetch(锁文件缓存层)→ 全量 COPY → 编译 shared/server
# runtime :仅 node:24-bookworm-slim,非 root 用户,含 dist 与 node_modules
# =====================================================================

FROM node:24-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"

# ------------------------------ builder ------------------------------
FROM base AS builder

# 原生依赖源码编译回退工具链(仅 builder 阶段安装,runtime 不含)
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先仅复制清单与 lockfile:pnpm fetch 作为可缓存层,源码变更不触发重新下载
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json

# 按 packageManager 字段(corepack)激活 pnpm@11.28.5
RUN corepack enable

# 依据 lockfile 把全部依赖预取进 store
RUN pnpm fetch

COPY . .

# 构建时从契约生成共享类型；仅 allowBuilds 中的依赖可执行构建脚本。
RUN pnpm install --frozen-lockfile

# shared 编译为 CommonJS dist:运行时 node 无法直引 TS(shared 的 main 指向
# src/index.ts),镜像内把入口改写为产物,保证 server dist 直接 require('@hmp/shared') 可用
RUN pnpm --filter @hmp/shared build

# server 编译为 dist(装饰器元数据,见 tsconfig.build.json)
RUN pnpm --filter @hmp/server build
RUN pnpm --filter @hmp/web build

# 宿主文件可能为 0600；SQL 与清单复制后必须允许 runtime 的 node 用户读取。
RUN chmod -R a+rX node_modules apps/server/node_modules apps/server/dist packages/shared/dist apps/web/dist \
  && chmod a+r package.json pnpm-workspace.yaml apps/server/package.json packages/shared/package.json

# ------------------------------ runtime ------------------------------
FROM base AS runtime

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data

WORKDIR /app

# 数据目录预先归属运行用户(compose 具名卷首次挂载会继承该属主)
RUN mkdir -p /data && chown node:node /data

# FFmpeg/ffprobe 运行时依赖(T004):Debian bookworm 发行版仓库,当前 7:5.1.9-0+deb12u1
# (随 security 更新浮动,主版本 5.1)。单一 ffmpeg 包同时提供 ffmpeg 与 ffprobe 两个
# 可执行文件;发行版构建启用 GPL 组件(libx264/libx265),提供 H.264/HEVC 软件编码与
# H.264/HEVC/AC3/EAC3/DTS 软件解码,无需自编译。linux/amd64 与 linux/arm64 均有官方
# 构建。不启用特权配置;硬件加速(VAAPI/QSV)仅 amd64 且需部署侧显式传递 /dev/dri。
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# 整体 node_modules(pnpm 软链布局)+ 各包清单与产物,保证 node dist/main.js 可起
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/server/package.json apps/server/package.json
COPY --from=builder /app/apps/server/node_modules apps/server/node_modules
COPY --from=builder /app/apps/server/dist apps/server/dist
COPY --from=builder /app/packages/shared/package.json packages/shared/package.json
COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/apps/web/dist apps/web/dist

USER node
EXPOSE 3000

# 镜像内无 curl:用 Node 内置 fetch 探活 /api/healthz
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["sh", "-c", "node apps/server/dist/database/migrate.js up && exec node apps/server/dist/main.js"]
