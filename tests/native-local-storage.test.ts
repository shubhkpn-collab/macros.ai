import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalFoodLogRepository, LocalEnergyGoalRepository, type StringStore } from '@macros/persistence';
import { createFoodLogItem } from '@macros/domain-food-log';
import { manualCapture } from '@macros/domain-weight';
import { instant } from '@macros/contracts';
import { SYNTHETIC_PRODUCTS, USER_A, USER_B } from '@macros/testkit';

const at = instant('2026-10-05T16:00:00.000Z');
class Store implements StringStore {
  data = new Map<string,string>(); fail = false;
  async getItem(key: string) { return this.data.get(key) ?? null; }
  async setItem(key: string,value: string) {
    if (this.fail) throw new Error('Disk full');
    this.data.set(key,value);
  }
}
const log = (id: string,userId = USER_A) => createFoodLogItem({
  logId: id, userId, productVersion: SYNTHETIC_PRODUCTS[0]!,
  weightCapture: manualCapture(94.5, at),
  loggedAt: at, timezone: 'America/Chicago',
});

test('native food logs survive restart with exact frozen nutrition and manual provenance', async () => {
  const store = new Store(); const first = await LocalFoodLogRepository.open(store,'logs');
  const item = log('a'); await first.append(item);
  const reopened = await LocalFoodLogRepository.open(store,'logs');
  assert.deepEqual(await reopened.findById(USER_A,'a'),item);
  assert.equal((await reopened.listByLocalDate(USER_A,'2026-10-05')).length,1);
  assert.equal((await reopened.listByLocalDate(USER_B,'2026-10-05')).length,0);
});
test('concurrent confirmation is idempotent across a restart', async () => {
  const store = new Store(); const repo = await LocalFoodLogRepository.open(store,'logs');
  const item = log('a'); await Promise.all([repo.append(item),repo.append(item)]);
  const reopened = await LocalFoodLogRepository.open(store,'logs');
  assert.equal(reopened.snapshot(USER_A,'2026-10-05').length,1);
  assert.equal((await reopened.append(item)).outcome,'replayed_existing');
});
test('failed durable writes do not appear committed and a retry can succeed', async () => {
  const store = new Store(); const repo = await LocalFoodLogRepository.open(store,'logs');
  store.fail = true; await assert.rejects(repo.append(log('a')),/Disk full/);
  assert.equal(await repo.findById(USER_A,'a'),null);
  store.fail = false; await repo.append(log('a'));
  assert.equal(repo.snapshot(USER_A,'2026-10-05').length,1);
});
test('local goals retain effective history and never accept duplicate version IDs', async () => {
  const store = new Store(); const repo = await LocalEnergyGoalRepository.open(store,'goals');
  const old = { goalVersionId: 'old', userId: USER_A, effectiveFrom: instant('2026-01-01T00:00:00.000Z'), goal: 'maintain' as const, targetDeltaKcal: 0 };
  const next = { ...old, goalVersionId: 'next', effectiveFrom: at, goal: 'lose' as const, targetDeltaKcal: -100 };
  await repo.append(old); await repo.append(next);
  const reopened = await LocalEnergyGoalRepository.open(store,'goals');
  assert.deepEqual(await reopened.getEffective(USER_A,'2026-10-04T16:00:00.000Z'),old);
  assert.deepEqual(await reopened.getEffective(USER_A,at),next);
  assert.equal(await reopened.getEffective(USER_B,at),null);
  await assert.rejects(reopened.append(next),/already exists/);
});
test('malformed local data fails at startup rather than silently deleting history', async () => {
  const store = new Store(); store.data.set('logs','{}');
  await assert.rejects(LocalFoodLogRepository.open(store,'logs'),/Invalid local/);
  assert.equal(store.data.get('logs'),'{}');
});
