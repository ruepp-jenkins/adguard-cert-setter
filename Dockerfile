ARG NODE_IMAGE_TAG=22-bookworm-slim

FROM node:${NODE_IMAGE_TAG} AS test
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN ./scripts/image-tests.sh /out

FROM scratch AS test-results
COPY --from=test /out/ /

FROM test AS verified
RUN test "$(cat /out/exit-code)" = "0"

FROM node:${NODE_IMAGE_TAG} AS runtime
ARG VCS_REF=unknown
ARG BUILD_DATE
LABEL org.opencontainers.image.title="AdGuard Home Certificate Setter" \
      org.opencontainers.image.description="Distributes a TLS certificate to all configured AdGuard Home instances" \
      org.opencontainers.image.source="https://github.com/ruepp-jenkins/adguard-cert-setter" \
      org.opencontainers.image.url="https://github.com/ruepp-jenkins/adguard-cert-setter" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.created="${BUILD_DATE}"
ENV NODE_ENV=production \
    APP_HOST=0.0.0.0 \
    APP_PORT=3000 \
    APP_DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts=false && npm cache clean --force
COPY --from=verified /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "const https=Boolean(process.env.APP_TLS_CERT_FILE); process.env.NODE_TLS_REJECT_UNAUTHORIZED='0'; fetch(`${https?'https':'http'}://127.0.0.1:${process.env.APP_PORT||3000}/health`).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/server/main.js"]
