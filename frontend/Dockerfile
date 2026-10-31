# Copyright (c) 2026 Intel Corporation
#
# SPDX-License-Identifier: Apache-2.0

# Stage 1: Build
#FROM node:20-alpine AS build
FROM node:22.14-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./

# 1. Upgrade npm to fix the 'edgesOut' internal bug
# 2. Clean the cache and install your packages
#RUN npm install -g npm@12.2.1 && \
#    npm cache clean --force && \
#    npm install

RUN npm install -g npm@11
RUN npm install
COPY . .
RUN npx ng build --configuration production

# Stage 2: Serve with nginx
FROM nginx:alpine
# Use underprivileged alpine
#FROM nginxinc/nginx-unprivileged:alpine
COPY --from=build /app/dist/pos-simulator/browser /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
#COPY nginx.conf /etc/nginx/nginx.conf
#RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
#  && chown -R appuser:appgroup /var/cache/nginx /var/run /var/log/nginx /usr/share/nginx/html
RUN addgroup -S appgroup \
    && adduser -S appuser -G appgroup \
    \
    # Remove nginx's user directive because container already runs as appuser
    && sed -i '/^[[:space:]]*user[[:space:]]/d' /etc/nginx/nginx.conf \
    \
    # Replace nginx PID location with writable /tmp
    && sed -i '/^[[:space:]]*pid[[:space:]]/d' /etc/nginx/nginx.conf \
    && sed -i '1i pid /tmp/nginx.pid;' /etc/nginx/nginx.conf \
    \
    && mkdir -p /var/cache/nginx /var/log/nginx \
    && chown -R appuser:appgroup \
       /var/cache/nginx \
       /var/log/nginx \
       /usr/share/nginx/html
USER appuser
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:80 || exit 1
CMD ["nginx", "-g", "daemon off;"]
