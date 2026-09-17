'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRedirectUri } = require('../server/twitch');

test('builds the Twitch callback from the public forwarded origin', () => {
  const req = {
    protocol: 'http',
    headers: {
      host: 'internal:3000',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'azurastreamer.syco23.org',
    },
  };

  assert.equal(
    buildRedirectUri(req),
    'https://azurastreamer.syco23.org/api/twitch/callback'
  );
});

test('uses the direct request origin when no proxy headers are present', () => {
  const req = { protocol: 'http', headers: { host: 'localhost:3000' } };

  assert.equal(buildRedirectUri(req), 'http://localhost:3000/api/twitch/callback');
});
