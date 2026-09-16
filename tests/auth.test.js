'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequireAuth } = require('../server/auth');

function makeResponse() {
  return {
    statusCode: null,
    body: null,
    redirectTo: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    redirect(location) { this.redirectTo = location; return this; },
  };
}

test('blocks unauthenticated API requests after setup', async () => {
  const requireAuth = createRequireAuth(async () => ({ ADMIN_PASSWORD: 'hash' }));
  const res = makeResponse();
  let nextCalled = false;

  await requireAuth({ path: '/api/settings', session: {} }, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { ok: false, error: 'Unauthorized' });
});

test('reports setup required to an unauthenticated API request before setup', async () => {
  const requireAuth = createRequireAuth(async () => ({}));
  const res = makeResponse();

  await requireAuth({ path: '/api/settings', session: {} }, res, () => {});

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { ok: false, error: 'Setup required' });
});

test('allows authenticated requests without querying settings', async () => {
  let getSettingsCalls = 0;
  const requireAuth = createRequireAuth(async () => {
    getSettingsCalls += 1;
    return {};
  });
  const res = makeResponse();
  let nextCalled = false;

  await requireAuth({ path: '/api/settings', session: { authenticated: true } }, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(getSettingsCalls, 0);
});
