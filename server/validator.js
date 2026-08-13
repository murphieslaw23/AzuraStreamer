'use strict';

const VALID_PLATFORMS = ['youtube', 'twitch'];
const VALID_TEMPLATES = ['1', '2', '3', '4'];

class ValidationError extends Error {
  constructor(field, message) {
    super(`${field}: ${message}`);
    this.field = field;
    this.name = 'ValidationError';
  }
}

function validateStreamStart(params) {
  const errors = [];

  // stationId validation
  if (!params.stationId) {
    errors.push(new ValidationError('stationId', 'required'));
  } else {
    const id = parseInt(params.stationId, 10);
    if (isNaN(id) || id <= 0) {
      errors.push(new ValidationError('stationId', 'must be a positive integer'));
    }
  }

  // stationName validation
  if (!params.stationName || typeof params.stationName !== 'string' || params.stationName.trim().length === 0) {
    errors.push(new ValidationError('stationName', 'required and must be non-empty string'));
  }

  // listenUrl validation
  if (!params.listenUrl || typeof params.listenUrl !== 'string') {
    errors.push(new ValidationError('listenUrl', 'required and must be string'));
  } else {
    try {
      const url = new URL(params.listenUrl);
      if (!['http:', 'https:'].includes(url.protocol)) {
        errors.push(new ValidationError('listenUrl', 'must use http or https protocol'));
      }
    } catch (e) {
      errors.push(new ValidationError('listenUrl', 'must be valid URL'));
    }
  }

  // platform validation
  if (!params.platform || !VALID_PLATFORMS.includes(params.platform)) {
    errors.push(new ValidationError('platform', `must be one of: ${VALID_PLATFORMS.join(', ')}`));
  }

  // template validation
  if (params.template) {
    const templateStr = String(params.template);
    if (!VALID_TEMPLATES.includes(templateStr)) {
      errors.push(new ValidationError('template', `must be one of: ${VALID_TEMPLATES.join(', ')}`));
    }
  }

  // manualStreamKey validation
  if (params.manualStreamKey) {
    if (typeof params.manualStreamKey !== 'string' || params.manualStreamKey.trim().length === 0) {
      errors.push(new ValidationError('manualStreamKey', 'must be a non-empty string'));
    } else {
      // Validate stream key format - should be alphanumeric with possible hyphens/underscores
      const streamKeyPattern = /^[a-zA-Z0-9_-]{20,100}$/;
      if (!streamKeyPattern.test(params.manualStreamKey.trim())) {
        errors.push(new ValidationError('manualStreamKey', 'must be 20-100 alphanumeric characters with hyphens or underscores'));
      }
    }
  }

  // title validation for auto-stream
  if (!params.manualStreamKey) {
    if (!params.title || typeof params.title !== 'string' || params.title.trim().length === 0) {
      errors.push(new ValidationError('title', 'required for auto-stream and must be non-empty'));
    }
  }

  // privacyStatus validation for YouTube
  if (params.platform === 'youtube' && params.privacyStatus) {
    const valid = ['public', 'private', 'unlisted'];
    if (!valid.includes(params.privacyStatus)) {
      errors.push(new ValidationError('privacyStatus', `must be one of: ${valid.join(', ')}`));
    }
  }

  if (errors.length > 0) {
    const err = new Error('Validation failed');
    err.validationErrors = errors;
    throw err;
  }
}

module.exports = {
  ValidationError,
  validateStreamStart,
  VALID_PLATFORMS,
  VALID_TEMPLATES
};
