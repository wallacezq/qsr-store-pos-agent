# Copyright (c) 2026 Intel Corporation
#
# SPDX-License-Identifier: Apache-2.0

FROM node:20-alpine
WORKDIR /app
# docker-cli lets the backend launch sibling DL Streamer containers via the
# mounted docker socket (vision-service pipelines).
RUN apk add --no-cache docker-cli
COPY package.json ./
RUN npm install --production
COPY src/ ./src/
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
# Pre-create the data dir owned by appuser so the named vision_data volume
# inherits writable ownership on first creation.
RUN mkdir -p /app/data && chown -R appuser:appgroup /app/data
USER appuser
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "src/server.js"]
