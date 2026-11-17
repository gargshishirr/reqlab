FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=4000 \
    HOST=0.0.0.0

WORKDIR /app

# Install exactly the locked production dependencies first (better layer caching).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy only what the server needs. The files stay owned by root, so the app can't change them.
COPY src ./src
COPY public ./public

# Run as the image's unprivileged "node" user.
USER node

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=4s --start-period=8s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" || exit 1

CMD ["node", "src/server.js"]
