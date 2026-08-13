'use strict';

const client = require('prom-client');

// Enable collection of default metrics (CPU, memory, etc.)
client.collectDefaultMetrics({
  timeout: 5000,
  prefix: 'azurastreamer_',
});

// Custom metrics
const activeStreamsGauge = new client.Gauge({
  name: 'azurastreamer_active_streams',
  help: 'Number of currently active streams',
  labelNames: ['platform'],
});

const streamDurationHistogram = new client.Histogram({
  name: 'azurastreamer_stream_duration_seconds',
  help: 'Duration of streams in seconds',
  labelNames: ['platform', 'station_id'],
  buckets: [60, 300, 600, 1800, 3600, 7200, 14400], // 1min to 4hours
});

const apiRequestsCounter = new client.Counter({
  name: 'azurastreamer_api_requests_total',
  help: 'Total number of API requests',
  labelNames: ['method', 'endpoint', 'status'],
});

const ffmpegProcessesGauge = new client.Gauge({
  name: 'azurastreamer_ffmpeg_processes',
  help: 'Number of active FFmpeg processes',
});

const listenersGauge = new client.Gauge({
  name: 'azurastreamer_listeners',
  help: 'Current number of listeners across all streams',
  labelNames: ['station_id'],
});

const errorsCounter = new client.Counter({
  name: 'azurastreamer_errors_total',
  help: 'Total number of errors',
  labelNames: ['type', 'module'],
});

// Metrics endpoint
function getMetrics(req, res) {
  res.set('Content-Type', client.register.contentType);
  res.end(client.register.metrics());
}

// Update stream metrics
function updateStreamMetrics(streams) {
  // Reset gauges
  activeStreamsGauge.reset();
  ffmpegProcessesGauge.set(0);
  
  let totalListeners = 0;
  
  for (const stream of streams) {
    // Count active streams by platform
    if (['live', 'starting', 'reconnecting'].includes(stream.status)) {
      activeStreamsGauge.inc({ platform: stream.platform });
      
      // Count FFmpeg processes
      if (stream.process) {
        ffmpegProcessesGauge.inc();
      }
      
      // Update listeners
      if (stream.stationId) {
        listenersGauge.set({ station_id: String(stream.stationId) }, stream.listeners || 0);
      }
      totalListeners += stream.listeners || 0;
    }
  }
  
  // Update total listeners
  listenersGauge.set({ station_id: 'total' }, totalListeners);
}

// Record API request
function recordApiRequest(method, endpoint, status) {
  apiRequestsCounter.inc({ method, endpoint, status });
}

// Record error
function recordError(type, module) {
  errorsCounter.inc({ type, module });
}

// Record stream duration
function recordStreamDuration(platform, stationId, durationSeconds) {
  streamDurationHistogram.observe({ platform, station_id: String(stationId) }, durationSeconds);
}

module.exports = {
  getMetrics,
  updateStreamMetrics,
  recordApiRequest,
  recordError,
  recordStreamDuration,
  client,
};
