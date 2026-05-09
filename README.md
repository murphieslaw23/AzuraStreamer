# AzuraStreamer

Stream your **AzuraCast** radio stations live to **YouTube** and **Twitch** with a single click. Built with Node.js, ffmpeg, and Socket.io — fully containerised with Docker.

---

## Features

- 🎙 **Live station dashboard** — fetches all stations and now-playing data from your AzuraCast instance
- 📡 **Real-time updates** — WebSocket pushes song changes, listener counts and stream status every 15 s
- 🎬 **Video generation** — ffmpeg renders a 1280×720 HD stream card with:
  - Scrolling waveform visualisation (colour-coded per platform)
  - Station name, artist, title, genre text overlays
  - Live listener count and clock
  - Platform badge (▶ YouTube Live / ● Twitch Live)
- ▶ **YouTube** and **●** **Twitch** targets — use the pre-filled YouTube key or enter your own Twitch key
- 🔁 **Metadata live-reload** — ffmpeg reads text files that update every poll cycle; no process restart needed on song change
- 🛡 **Duplicate guard** — prevents starting the same station→platform stream twice
- 📋 **Uptime counter** — per-stream elapsed timer in the active streams panel
- 🍞 **Toast notifications** — success / warning / error feedback for all actions
- 📱 **Fully responsive** — single-column layout on mobile, two-column on desktop

---

## Quick Start

```bash
# 1. Clone / enter the project
cd AzuraStreamer

# 2. Run the automated setup (optional, installs Docker/Node/FFmpeg)
sudo ./install.sh

# 3. Build and start
docker compose up -d --build

# 4. Open the UI
xdg-open http://localhost:3000
```

---

## Usage

1. **Select a station** from the dashboard cards (or use the sidebar form)
2. **Choose a mount** (bitrate / format shown)
3. **Pick a platform** — YouTube key is pre-filled; enter your Twitch key manually
4. **Start Streaming** — the stream card appears in *Active Streams* and transitions from `STARTING` → `LIVE`
5. **Stop** any stream at any time with the Stop button

---

## Configuration

All settings are in `docker-compose.yml` under `environment`:

| Variable | Description |
|---|---|
| `AZURACAST_API_URL` | AzuraCast API base URL |
| `AZURACAST_API_KEY` | API key (`id:secret` format) |
| `YOUTUBE_STREAM_KEY` | Pre-filled YouTube stream key |
| `PORT` | HTTP port (default `3000`) |

To add a Twitch key permanently, add `TWITCH_STREAM_KEY` to the environment and read it in `server/index.js`.

---

## Architecture

```
Browser (UI)
    │  HTTP REST + WebSocket (Socket.io)
    ▼
Node.js / Express  (port 3000)
    │
    ├── GET  /api/stations          → AzuraCast proxy
    ├── GET  /api/nowplaying        → AzuraCast proxy
    ├── POST /api/streams/start     → spawns ffmpeg process
    └── DELETE /api/streams/:id    → kills ffmpeg process

ffmpeg (child process per stream)
    ├── Input:  AzuraCast Icecast MP3 stream URL
    ├── Video:  1280×720 colour background + showwaves filter
    ├── Text:   drawtext reading /tmp/azurastreamer/<id>/*.txt  (reload=1)
    ├── YouTube → HLS over HTTPS  (HTTP PUT to upload.youtube.com)
    └── Twitch  → RTMP/FLV  (rtmp://live.twitch.tv/app/KEY)
```

**Text file hot-reload** — every poll cycle the server updates the `.txt` files in the stream's data directory. ffmpeg's `drawtext:reload=1` re-reads each file on every frame at negligible cost (files are <100 bytes).

---

## Stream Quality

| Parameter | Value |
|---|---|
| Resolution | 1280 × 720 (HD) |
| Video codec | H.264 (`libx264 veryfast`) |
| Video bitrate | 3 000 kbps |
| Audio codec | AAC |
| Audio bitrate | 160 kbps |
| Frame rate | 30 fps |
| Keyframe interval | 2 s |
| **YouTube output** | HLS over HTTPS (`-f hls`, HTTP PUT, 2 s segments) |
| **Twitch output** | RTMP/FLV (`rtmp://live.twitch.tv/app/KEY`) |

---

## Commands

```bash
# Start
docker compose up -d

# Stop
docker compose down

# View logs
docker compose logs -f

# Rebuild after code changes
docker compose up -d --build

# Container shell
docker exec -it azurastreamer bash
```

---

## File Layout

```
AzuraStreamer/
├── Dockerfile
├── docker-compose.yml
├── .dockerignore
├── README.md
├── server/
│   ├── package.json
│   └── index.js          ← Express + Socket.io + ffmpeg manager
└── public/
    ├── index.html
    ├── style.css
    └── app.js
```
