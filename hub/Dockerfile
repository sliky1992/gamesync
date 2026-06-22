# ---- build stage ----
FROM node:20-slim AS build
WORKDIR /app
# OpenSSL is needed by Prisma's engine.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run db:generate && npm run build

# ---- runtime stage ----
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm install --omit=dev && npm cache clean --force
RUN npx prisma generate
COPY --from=build /app/dist ./dist
COPY public ./public
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

ENV DATABASE_URL="file:/data/gamesync.db"
ENV STORAGE_DIR="/data/storage"
ENV PORT=8080
EXPOSE 8080
VOLUME ["/data"]

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
