# The API image (docs/STAGING.md). One image, two commands:
#   release step:  node dist/migrate.mjs          (then: node dist/migrate.mjs --verify)
#   web process:   node dist/main.mjs
# Configuration comes only from the environment (server/.env.example lists the
# names). No secrets are baked into the image.
#
# Build context: the repository root (the API bundles the shared domain from src/).
#   docker build -f server/Dockerfile -t velvet-api .

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci
COPY src ./src
COPY server ./server
RUN cd server && npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /srv
COPY --from=build /app/server/node_modules ./node_modules
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/server/migrations ./migrations
COPY --from=build /app/server/package.json ./package.json
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.mjs"]
