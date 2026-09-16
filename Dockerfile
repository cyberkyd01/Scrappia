# Scrappia server: REST API + scheduler running the core engine headlessly.
# Build:  docker build -t scrappia-server .
# Run:    docker run -p 8788:8788 -e SCRAPPIA_API_KEY=change-me -v scrappia-data:/data scrappia-server
FROM node:22-bookworm

ENV NODE_ENV=production \
    SCRAPPIA_HOME=/data \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PORT=8788 \
    HOST=0.0.0.0

WORKDIR /app

# Install dependencies first (root install; the repo has no npm workspaces, packages are linked by a script).
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci --no-audit --no-fund --ignore-scripts

# Chromium + its system libraries for patchright (stealth Playwright fork used by the engine).
RUN npx patchright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* /root/.cache

# Sources: only what the server needs (core + server + shared tsconfig).
COPY tsconfig.base.json ./
COPY packages/core ./packages/core
COPY apps/server ./apps/server

RUN node scripts/link-packages.mjs \
    && npm run build --prefix packages/core \
    && npm run build --prefix apps/server

RUN mkdir -p /data && chown -R node:node /data /app /ms-playwright
USER node
VOLUME ["/data"]
EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/server/dist/index.js"]
