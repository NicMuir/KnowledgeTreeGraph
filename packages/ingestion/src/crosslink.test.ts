import test from 'node:test';
import assert from 'node:assert';
import { parseNodeName, isDynamic, matchQuality, staticOverlap } from './crosslink';

test('parseNodeName splits method + segments', () => {
  assert.deepStrictEqual(parseNodeName('GET /api/bookings/{}'), { method: 'GET', segs: ['api', 'bookings', '{}'] });
  assert.deepStrictEqual(parseNodeName('POST /'), { method: 'POST', segs: [] });
  assert.strictEqual(parseNodeName('nonsense'), null);
});

test('isDynamic recognizes param styles across frameworks', () => {
  for (const seg of [':id', '{id}', '{}', '<id>', '$id', '*']) {
    assert.ok(isDynamic(seg), `${seg} should be dynamic`);
  }
  assert.ok(!isDynamic('bookings'));
});

test('matchQuality: exact static match', () => {
  assert.strictEqual(matchQuality(['api', 'bookings'], ['api', 'bookings']), 'exact');
  assert.strictEqual(matchQuality(['api', 'bookings'], ['api', 'orders']), null);
});

test('matchQuality: length mismatch never matches', () => {
  assert.strictEqual(matchQuality(['api', 'bookings'], ['api', 'bookings', '{}']), null);
});

test('matchQuality: wildcard on either side → param match', () => {
  // route param binds a static call segment: GET /bookings/active -> /bookings/:id
  assert.strictEqual(matchQuality(['bookings', 'active'], ['bookings', ':id']), 'param');
  // call interpolation binds a static route segment: GET /a/{}/c -> /a/b/c
  assert.strictEqual(matchQuality(['a', '{}', 'c'], ['a', 'b', 'c']), 'param');
  // both dynamic
  assert.strictEqual(matchQuality(['users', '{}'], ['users', '{id}']), 'param');
  // static mismatch outside the wildcard still fails
  assert.strictEqual(matchQuality(['users', '{}'], ['orders', '{id}']), null);
});

test('staticOverlap disambiguates competing param matches', () => {
  const call = ['api', 'bookings', '{}', 'locks'];
  // correct route: shares api, bookings, locks statically = 3
  assert.strictEqual(staticOverlap(call, ['api', 'bookings', '{booking_id}', 'locks']), 3);
  // wrong route: shares only api, bookings = 2 → loses the tiebreak
  assert.strictEqual(staticOverlap(call, ['api', 'bookings', 'by_code', '{code}']), 2);
});
