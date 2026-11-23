FROM node:22-bookworm-slim AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/reference-host/package.json apps/reference-host/
COPY apps/reference-web/package.json apps/reference-web/
COPY packages/actions/package.json packages/actions/
COPY packages/ai/package.json packages/ai/
COPY packages/browser-runtime/package.json packages/browser-runtime/
COPY packages/contracts/package.json packages/contracts/
COPY packages/security/package.json packages/security/
COPY packages/testkit/package.json packages/testkit/
COPY packages/walkthrough/package.json packages/walkthrough/

FROM manifests AS build
RUN npm ci
COPY tsconfig.base.json ./
COPY apps/reference-host/tsconfig.json apps/reference-host/
COPY apps/reference-host/src/ apps/reference-host/src/
COPY packages/ packages/
RUN npx tsc -b apps/reference-host

FROM manifests AS runtime-dependencies
RUN npm ci --omit=dev

FROM runtime-dependencies AS runtime
COPY --from=build /app/apps/reference-host/dist/ apps/reference-host/dist/
COPY --from=build /app/packages/actions/dist/ packages/actions/dist/
COPY --from=build /app/packages/ai/dist/ packages/ai/dist/
COPY --from=build /app/packages/browser-runtime/dist/ packages/browser-runtime/dist/
COPY --from=build /app/packages/contracts/dist/ packages/contracts/dist/
COPY --from=build /app/packages/security/dist/ packages/security/dist/
COPY --from=build /app/packages/walkthrough/dist/ packages/walkthrough/dist/
COPY apps/reference-host/knowledge/ apps/reference-host/knowledge/
COPY db/migrate.mjs db/
COPY db/migrations/ db/migrations/
USER node
EXPOSE 8787
CMD ["node", "apps/reference-host/dist/http/dev-server.js"]
