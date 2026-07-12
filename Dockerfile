# Seatscope — minimal production image
FROM node:24-alpine

WORKDIR /app

# Install only production deps first (better layer caching)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source
COPY . .

# Connector config, manual licenses and price overrides live here.
# Mount this as a volume to persist data across restarts (see compose.yaml).
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000

CMD ["node", "server.js"]
