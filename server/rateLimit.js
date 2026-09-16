'use strict';

const { ipKeyGenerator } = require('express-rate-limit');

function streamCreationKey(req) {
  return `${ipKeyGenerator(req.ip)}:${String(req.body?.stationId || '')}`;
}

module.exports = { streamCreationKey };
