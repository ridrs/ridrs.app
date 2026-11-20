// SPDX-License-Identifier: AGPL-3.0-or-later
// node --test test/ — ridrs Scenic under a path of ridrs.app (src/base.js, BASE_PATH "/scenic").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basePath, routePath } from '../src/base.js';

test('basePath normalises the variable', () => {
  assert.equal(basePath({ BASE_PATH: '/scenic' }), '/scenic');
  assert.equal(basePath({ BASE_PATH: 'scenic/' }), '/scenic');
  assert.equal(basePath({}), '');
});

test('routePath: inside the base, redirects to the slash form, everything else is outside', () => {
  assert.deepEqual(routePath('/scenic/api/points', '/scenic'), { path: '/api/points' });
  assert.deepEqual(routePath('/scenic/', '/scenic'), { path: '/' });
  assert.deepEqual(routePath('/scenic', '/scenic'), { redirect: '/scenic/' });
  assert.deepEqual(routePath('/', '/scenic'), { redirect: '/scenic/' });
  assert.deepEqual(routePath('/scenic/admin', '/scenic'), { redirect: '/scenic/admin/' });
  assert.deepEqual(routePath('/scenicx/api/points', '/scenic'), { outside: true });
  assert.deepEqual(routePath('/api/points', '/scenic'), { outside: true });
  assert.deepEqual(routePath('/api/points', ''), { path: '/api/points' });
});
