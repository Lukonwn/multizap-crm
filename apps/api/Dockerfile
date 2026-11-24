# multizap-api — build a partir da raiz do repositório (contexto = monorepo)
FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10.28.0
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@multizap/api
ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "--enable-source-maps", "apps/api/dist/server.js"]
