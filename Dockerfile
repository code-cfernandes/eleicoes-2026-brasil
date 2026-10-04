FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    HISTORICO_DB=/app/data/eleicoes.db

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .
# Volume do SQLite: criado como "node" para o volume nomeado herdar o dono
RUN mkdir -p /app/data && chown node:node /app/data
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/api/saude" || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
