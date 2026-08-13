const test = require('node:test');
const assert = require('node:assert/strict');

const { validateStreamStart, ValidationError, VALID_PLATFORMS, VALID_TEMPLATES } = require('../server/validator');

test('VALID_PLATFORMS contains expected platforms', () => {
  assert.deepEqual(VALID_PLATFORMS, ['youtube', 'twitch']);
});

test('VALID_TEMPLATES contains expected templates', () => {
  assert.deepEqual(VALID_TEMPLATES, ['1', '2', '3', '4']);
});

test('validateStreamStart accepts valid params', () => {
  const validParams = {
    stationId: '1',
    stationName: 'Test Station',
    listenUrl: 'http://example.com/stream',
    platform: 'youtube',
    template: '1',
    title: 'Test Stream',
    privacyStatus: 'public'
  };
  
  assert.doesNotThrow(() => validateStreamStart(validParams));
});

test('validateStreamStart rejects missing stationId', () => {
  const params = {
    stationName: 'Test Station',
    listenUrl: 'http://example.com/stream',
    platform: 'youtube'
  };
  
  assert.throws(() => validateStreamStart(params), /Validation failed/);
});

test('validateStreamStart rejects invalid stationId', () => {
  const params = {
    stationId: '-1',
    stationName: 'Test Station',
    listenUrl: 'http://example.com/stream',
    platform: 'youtube'
  };
  
  assert.throws(() => validateStreamStart(params), /Validation failed/);
});

test('validateStreamStart rejects missing stationName', () => {
  const params = {
    stationId: '1',
    listenUrl: 'http://example.com/stream',
    platform: 'youtube'
  };
  
  assert.throws(() => validateStreamStart(params), /Validation failed/);
});

test('validateStreamStart rejects invalid listenUrl', () => {
  const params = {
    stationId: '1',
    stationName: 'Test Station',
    listenUrl: 'ftp://example.com/stream',
    platform: 'youtube'
  };
  
  assert.throws(() => validateStreamStart(params), /Validation failed/);
});

test('validateStreamStart rejects invalid platform', () => {
  const params = {
    stationId: '1',
    stationName: 'Test Station',
    listenUrl: 'http://example.com/stream',
    platform: 'facebook'
  };
  
  assert.throws(() => validateStreamStart(params), /Validation failed/);
});

test('validateStreamStart rejects invalid template', () => {
  const params = {
    stationId: '1',
    stationName: 'Test Station',
    listenUrl: 'http://example.com/stream',
    platform: 'youtube',
    template: '5'
  };
  
  assert.throws(() => validateStreamStart(params), /Validation failed/);
});

test('validateStreamStart requires title for auto-stream', () => {
  const params = {
    stationId: '1',
    stationName: 'Test Station',
    listenUrl: 'http://example.com/stream',
    platform: 'youtube'
  };
  
  assert.throws(() => validateStreamStart(params), /Validation failed/);
});

test('validateStreamStart accepts manualStreamKey without title', () => {
  const params = {
    stationId: '1',
    stationName: 'Test Station',
    listenUrl: 'http://example.com/stream',
    platform: 'youtube',
    manualStreamKey: 'valid-stream-key-12345678901234567890'
  };
  
  assert.doesNotThrow(() => validateStreamStart(params));
});

test('validateStreamStart rejects invalid manualStreamKey format', () => {
  const params = {
    stationId: '1',
    stationName: 'Test Station',
    listenUrl: 'http://example.com/stream',
    platform: 'youtube',
    manualStreamKey: 'invalid!key'
  };
  
  assert.throws(() => validateStreamStart(params), /Validation failed/);
});

test('validateStreamStart rejects too short manualStreamKey', () => {
  const params = {
    stationId: '1',
    stationName: 'Test Station',
    listenUrl: 'http://example.com/stream',
    platform: 'youtube',
    manualStreamKey: 'short'
  };
  
  assert.throws(() => validateStreamStart(params), /Validation failed/);
});

test('validateStreamStart accepts valid manualStreamKey', () => {
  const params = {
    stationId: '1',
    stationName: 'Test Station',
    listenUrl: 'http://example.com/stream',
    platform: 'youtube',
    manualStreamKey: 'valid-stream-key-12345678901234567890'
  };
  
  assert.doesNotThrow(() => validateStreamStart(params));
});

test('validateStreamStart validates YouTube privacyStatus', () => {
  const validStatuses = ['public', 'private', 'unlisted'];
  
  for (const status of validStatuses) {
    const params = {
      stationId: '1',
      stationName: 'Test Station',
      listenUrl: 'http://example.com/stream',
      platform: 'youtube',
      title: 'Test Stream',
      privacyStatus: status
    };
    assert.doesNotThrow(() => validateStreamStart(params), `Should accept ${status}`);
  }
  
  const params = {
    stationId: '1',
    stationName: 'Test Station',
    listenUrl: 'http://example.com/stream',
    platform: 'youtube',
    title: 'Test Stream',
    privacyStatus: 'invalid'
  };
  assert.throws(() => validateStreamStart(params), /Validation failed/);
});
