# syntax=docker/dockerfile:1

FROM node:24-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json .npmrc ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
    && npm prune --omit=dev \
    && npm cache clean --force

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Database persistence is provided by MongoDB Atlas, outside the container.
RUN addgroup -S relay && adduser -S relay -G relay \
    && chown -R relay:relay /app
USER relay

ENV PORT=4001
EXPOSE 4001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
