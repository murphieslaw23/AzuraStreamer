'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { streamCreationKey } = require('../server/rateLimit');

test('stream creation keys normalize IPv6 addresses before adding the station', () => {
  const first = streamCreationKey({ ip: '2001:db8:85a3::8a2e:370:7334', body: { stationId: '7' } });
  const sameStation = streamCreationKey({ ip: '2001:db8:85a3::8a2e:370:7334', body: { stationId: '7' } });
  const otherStation = streamCreationKey({ ip: '2001:db8:85a3::8a2e:370:7334', body: { stationId: '8' } });

  assert.equal(first, sameStation);
  assert.notEqual(first, otherStation);
  assert.match(first, /:7$/);
});
