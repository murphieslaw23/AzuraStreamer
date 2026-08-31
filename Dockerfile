# Stage 1: Build dependencies
FROM node:20-slim as builder

LABEL maintainer="AzuraStreamer"
LABEL description="AzuraCast → YouTube/Twitch Live Stream Controller"

# Install ffmpeg + fonts + chromium deps for puppeteer.
# The 4 broadcast templates use a custom type stack: Barlow Condensed Bold
# (display/titles), Inter variable (body/artist), JetBrains Mono variable
# (mono data). google/fonts ships static cuts of Barlow + JetBrains Mono;
# Inter is only distributed as a variable font, which ffmpeg's drawtext
# handles fine. The TTFs land in /usr/share/fonts/truetype/ and ffmpeg
# finds them by file path via `fontfile=`. curl is needed to fetch the
# TTFs at build time; node:20-slim doesn't ship it.
RUN apt-get update && apt-get install -y --no-install-recommends \
  ffmpeg \
  fonts-dejavu-core \
  fonts-liberation \
  ca-certificates \
  chromium \
  build-essential \
  python3 \
  curl \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /usr/share/fonts/truetype/syco \
  && curl -fsSL -o /usr/share/fonts/truetype/syco/BarlowCondensed-Bold.ttf \
       https://github.com/google/fonts/raw/main/ofl/barlowcondensed/BarlowCondensed-Bold.ttf \
  && curl -fsSL -o /usr/share/fonts/truetype/syco/BarlowCondensed-Regular.ttf \
       https://github.com/google/fonts/raw/main/ofl/barlowcondensed/BarlowCondensed-Regular.ttf \
  && curl -fsSL -o /usr/share/fonts/truetype/syco/BarlowCondensed-Black.ttf \
       https://github.com/google/fonts/raw/main/ofl/barlowcondensed/BarlowCondensed-Black.ttf \
  && curl -fsSL -o /usr/share/fonts/truetype/syco/Inter-Variable.ttf \
       "https://github.com/google/fonts/raw/main/ofl/inter/Inter%5Bopsz,wght%5D.ttf" \
  && curl -fsSL -o /usr/share/fonts/truetype/syco/JetBrainsMono-Variable.ttf \
       "https://github.com/google/fonts/raw/main/ofl/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf" \
  && fc-cache -f

# Skip puppeteer Chromium download, use system chromium
>>>>>>> 6aac436 (AzuraStreamer pipeline hardening + template 5 redesign)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app

# Install build dependencies including unzip for puppeteer
RUN apt-get update && apt-get install -y --no-install-recommends \
  python3 \
  make \
  g++ \
  unzip \
  && rm -rf /var/lib/apt/lists/*

# Copy package files and install dependencies
COPY server/package*.json ./
RUN npm install --omit=dev

# Stage 2: Runtime image
FROM node:20-alpine

LABEL maintainer="AzuraStreamer"
LABEL description="AzuraCast → YouTube/Twitch Live Stream Controller"

# Install runtime dependencies
RUN apk add --no-cache --update \
  ffmpeg \
  font-dejavu \
  ca-certificates \
  chromium \
  nss \
  freetype \
  harfbuzz \
  ttf-freefont \
  && update-ca-certificates

# Skip puppeteer Chromium download, use system chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app

# Copy node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy server source
COPY server/*.js ./

# Copy frontend static files
COPY public/ ./public/

# Runtime temp directory for stream metadata files and DB
RUN mkdir -p /tmp/azurastreamer /app/data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', function (r) { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', function () { process.exit(1); })"

CMD ["node", "index.js"]