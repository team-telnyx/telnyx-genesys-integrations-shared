# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
COPY package.json yarn.lock .yarnrc.yml ./
RUN yarn install --immutable

FROM dependencies AS builder
# .dockerignore excludes .git, so the build cannot derive its own identity.
# The build host captures a snapshot (scripts/build-info.mjs) and passes it
# here; next.config.mjs validates its version against the package.json that
# actually ships. Without it the image is honestly labelled a development
# build rather than silently claiming a release.
ARG GI_BUILD_INFO=""
ENV GI_BUILD_INFO=$GI_BUILD_INFO
COPY . .
RUN yarn build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000

RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs --home-dir /app nextjs

COPY --from=dependencies --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/lib ./lib
COPY --from=builder --chown=nextjs:nodejs /app/genesys ./genesys
COPY --from=builder --chown=nextjs:nodejs /app/server.mjs ./server.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
# next.config.mjs is loaded again at run time and imports scripts/lib, which is
# why scripts/ ships above. GI_BUILD_INFO is deliberately *not* carried into
# this stage: the identity is already compiled into .next, and no runtime
# variable may relabel a built image.
COPY --from=builder --chown=nextjs:nodejs /app/next.config.mjs ./next.config.mjs
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json

RUN mkdir -p /app/.genesys-audio /app/.genesys-widget /app/.genesys-admin /app/.genesys-shared /app/.widget-assets \
    && chown -R nextjs:nodejs /app/.genesys-audio /app/.genesys-widget /app/.genesys-admin /app/.genesys-shared /app/.widget-assets

USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
