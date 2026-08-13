'use strict';

const pino = require('pino');

// Create logger with appropriate level based on environment
const level = process.env.NODE_ENV === 'production' ? 'info' : 'debug';

const logger = pino({
  level: level,
  formatters: {
    level: (label) => {
      return { level: label };
    },
    log: (object) => {
      // Add timestamp in ISO format
      return { ...object, timestamp: new Date().toISOString() };
    }
  },
  serializers: {
    req: (req) => ({
      method: req.method,
      url: req.url,
      ip: req.ip,
      userAgent: req.headers['user-agent']
    }),
    res: (res) => ({
      status: res.statusCode,
      headers: res.getHeaders()
    }),
    err: (err) => ({
      type: err.name,
      message: err.message,
      stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined
    })
  },
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: process.env.NODE_ENV !== 'production',
      translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
      ignore: 'pid,hostname'
    }
  }
});

// Create HTTP logger middleware
const httpLogger = require('pino-http')({
  logger: logger,
  customLogLevel: (req, res, err) => {
    if (res.statusCode >= 500 || err) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customSuccessMessage: (req, res) => {
    return `${req.method} ${req.url} - ${res.statusCode}`;
  },
  customErrorMessage: (req, res, err) => {
    return `${req.method} ${req.url} - ${res.statusCode} - ${err.message}`;
  }
});

module.exports = {
  logger,
  httpLogger
};
