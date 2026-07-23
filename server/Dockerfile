# Node 24：node:sqlite 已內建，ARM（Graviton）不需編譯原生模組
FROM node:24-alpine

WORKDIR /app

# 沒有任何 npm 相依，只複製程式碼
COPY package.json server.js ./

# 資料目錄由 volume 掛入，先建好並交給非 root 的 node 使用者
RUN mkdir -p /data && chown -R node:node /data /app

USER node

ENV NODE_ENV=production \
    DB_PATH=/data/stats.db \
    PORT=3000

EXPOSE 3000

# 容器內自我檢查，異常時 docker 會標記為 unhealthy
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
