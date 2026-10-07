# Proxy-only image. Agent images install it with `npm i -g acp-web-proxy`
# (or COPY --from this image) next to their agent.
FROM node:22-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /opt/acp-web-proxy
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY package.json ./
RUN ln -s /opt/acp-web-proxy/dist/cli.js /usr/local/bin/acp-web-proxy && chmod +x dist/cli.js
USER node
EXPOSE 8000
ENTRYPOINT ["acp-web-proxy"]
CMD ["--config", "/etc/acp-web-proxy/config.yaml"]
