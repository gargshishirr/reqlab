FROM node:20-alpine

WORKDIR /app

# Install production dependencies first (better layer caching).
COPY package.json ./
RUN npm install --omit=dev

# Copy the application.
COPY . .

ENV NODE_ENV=production \
    PORT=4000 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data

# Persisted collections / environments / history.
VOLUME ["/app/data"]

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=4s --start-period=8s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/api/health || exit 1

CMD ["node", "src/server.js"]
