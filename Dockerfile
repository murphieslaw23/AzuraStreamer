FROM node:20-slim

LABEL maintainer="AzuraStreamer"
LABEL description="AzuraCast → YouTube/Twitch Live Stream Controller"

# Install ffmpeg + fonts + chromium deps for puppeteer
RUN apt-get update && apt-get install -y --no-install-recommends \
  ffmpeg \
  fonts-dejavu-core \
  fonts-liberation \
  ca-certificates \
  chromium \
  && rm -rf /var/lib/apt/lists/*

# Skip puppeteer Chromium download, use system chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Install dependencies first (Docker cache layer)
COPY server/package*.json ./
RUN npm install --omit=dev

# Copy server source
COPY server/*.js ./

# Copy frontend static files
COPY public/ ./public/

# Runtime temp directory for stream metadata files and DB
RUN mkdir -p /tmp/azurastreamer /app/data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "index.js"]
