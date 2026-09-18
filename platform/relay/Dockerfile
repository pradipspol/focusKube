# syntax=docker/dockerfile:1

# better-sqlite3 and bcrypt both ship prebuilt native bindings for linuxmusl (Alpine), so
# plain `npm ci` works here with no node-gyp/python/build-base toolchain needed.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# RELAY_DB_PATH defaults to ./data/relay.db (relative to cwd) — /app/data is the mount
# point for a persistent volume so the SQLite file survives container recreation.
RUN addgroup -S relay && adduser -S relay -G relay \
    && mkdir -p /app/data \
    && chown -R relay:relay /app
USER relay
VOLUME ["/app/data"]

ENV PORT=4001
EXPOSE 4001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
