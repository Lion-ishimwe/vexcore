# CMS (Construction Management System) - single app image.
# Stage 1 builds the React web app; stage 2 runs the API, which also serves
# the built web app (api/src/server.js picks up ../web/dist automatically).

# ---- Stage 1: build the web UI ----
FROM node:20-alpine AS webbuild
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- Stage 2: the API runtime ----
FROM node:20-alpine
# Prisma's query engine needs openssl on alpine
RUN apk add --no-cache openssl

WORKDIR /app/api
COPY api/package.json api/package-lock.json ./
# Dev deps stay in: the prisma CLI is needed at container start (db push)
RUN npm ci
COPY api/ ./
RUN npx prisma generate

# The built web app where server.js expects it (../web/dist from api/)
COPY --from=webbuild /web/dist /app/web/dist
# Platform logo fallback used by the schedule PDF letterhead
COPY logo.png /app/logo.png

COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=4311
EXPOSE 4311

# Uploads (worker photos, report media, logos) live here - mount a volume
VOLUME /app/api/uploads

ENTRYPOINT ["/app/docker-entrypoint.sh"]
