import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLIProxyClient } from '../src/client';
import { QuotaMonitor, refreshIntervalFromMinutes } from '../src/monitor';
import { record } from '../src/quota';
import { serve, weekly } from './server';

const files = [
  { name: 'x1', type: 'codex', auth_index: 'x1' },
  { name: 'x2', type: 'codex', auth_index: 'x2' },
  { name: 'c', type: 'claude', auth_index: 'c' },
];

test('a custom refresh interval applies immediately without clearing readings or triggering an extra request', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1800000000000 });
  let discoveries = 0;
  const url = await serve(t, request => {
    if (request.path.endsWith('auth-files')) { discoveries++; return { body: { files: [files[0]] } }; }
    return { body: { status_code: 200, body: weekly(20) } };
  });
  const monitor = new QuotaMonitor(new CLIProxyClient(url, 'test-key'), () => {}, 120000);
  t.after(() => monitor.dispose());
  monitor.start();
  await monitor.refresh();
  assert.equal(discoveries, 1);
  t.mock.timers.tick(119999);
  assert.equal(monitor.refreshing, false);
  t.mock.timers.tick(1);
  assert.equal(monitor.refreshing, true);
  await monitor.refresh();
  assert.equal(discoveries, 2);
  const previous = monitor.state;
  monitor.setRefreshInterval(600000);
  assert.equal(monitor.refreshIntervalMs, 600000);
  assert.equal(monitor.state, previous);
  assert.equal(monitor.state[1]?.summary?.used, 20);
  assert.equal(monitor.refreshing, false);
  t.mock.timers.tick(599999);
  assert.equal(monitor.refreshing, false);
  assert.equal(discoveries, 2);
  t.mock.timers.tick(1);
  assert.equal(monitor.refreshing, true);
  await monitor.refresh();
  assert.equal(discoveries, 3);
});

test('invalid refresh interval settings fall back to five minutes', () => {
  for (const value of [undefined, null, '1', 0, -1, 1.5, 1441, NaN, Infinity]) {
    assert.equal(refreshIntervalFromMinutes(value), 300000);
  }
  assert.equal(refreshIntervalFromMinutes(1), 60000);
  assert.equal(refreshIntervalFromMinutes(5), 300000);
  assert.equal(refreshIntervalFromMinutes(1440), 86400000);
});

test('manual refresh clears a stale provider during local cooldown while automatic polling remains paused', async t => {
  let calls = 0;
  let failing = false;
  const url = await serve(t, request => {
    if (request.path.endsWith('auth-files')) return { body: { files: [files[0]] } };
    calls++;
    return { body: failing ? { status_code: 429, header: { 'Retry-After': ['0'] }, body: {} }
      : { status_code: 200, body: weekly(calls === 1 ? 20 : 30) } };
  });
  const monitor = new QuotaMonitor(new CLIProxyClient(url, 'test-key'), () => {});
  t.after(() => monitor.dispose());
  await monitor.refresh();
  assert.equal(monitor.state[1]?.summary?.used, 20);
  failing = true;
  await monitor.refresh();
  failing = false;
  await monitor.refresh();
  assert.equal(calls, 2);
  assert.equal(monitor.state[1]?.summary?.used, 20);
  assert.ok(monitor.state[1]?.error);
  await monitor.refresh('manual');
  assert.equal(calls, 3);
  assert.equal(monitor.state[1]?.summary?.used, 30);
  assert.equal(monitor.state[1]?.error, undefined);
  assert.equal(monitor.state[1]?.accounts[0]?.error, undefined);
});

test('a manual refresh during an automatic cycle queues one real retry and coalesces repeated clicks', async t => {
  let quotaCalls = 0;
  let discoveries = 0;
  let hold = false;
  let release: (() => void) | undefined;
  const url = await serve(t, async request => {
    if (request.path.endsWith('auth-files')) {
      discoveries++;
      if (hold) await new Promise<void>(resolve => { release = resolve; });
      return { body: { files: [files[0]] } };
    }
    quotaCalls++;
    return { body: quotaCalls === 1 ? { status_code: 429, header: { 'Retry-After': ['0'] }, body: {} }
      : { status_code: 200, body: weekly(2) } };
  });
  const monitor = new QuotaMonitor(new CLIProxyClient(url, 'test-key'), () => {});
  t.after(() => monitor.dispose());
  await monitor.refresh();
  hold = true;
  const automatic = monitor.refresh();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const manual1 = monitor.refresh('manual');
  const manual2 = monitor.refresh('manual');
  hold = false;
  release();
  await Promise.all([automatic, manual1, manual2]);
  assert.equal(quotaCalls, 2);
  assert.equal(discoveries, 3);
  assert.equal(monitor.state[1]?.summary?.used, 2);
  assert.equal(monitor.state[1]?.error, undefined);
});

test('a refresh discovers accounts and calculates independent provider averages', async t => {
  const url = await serve(t, request => request.path.endsWith('auth-files') ? { body: { files } }
    : { body: { status_code: 200, body: record(request.body)?.auth_index === 'c'
      ? { five_hour: { utilization: 82 }, seven_day: { utilization: 90 } }
      : weekly(record(request.body)?.auth_index === 'x1' ? 20 : 80) } });
  const monitor = new QuotaMonitor(new CLIProxyClient(url, 'test-key'), () => {});
  t.after(() => monitor.dispose());
  await monitor.refresh();
  assert.deepEqual(monitor.state.map(p => [p.provider, p.summary?.used, p.summary?.seconds, p.accounts.length, p.error]), [
    ['claude', 82, 18000, 1, undefined], ['codex', 50, 604800, 2, undefined],
  ]);
});

test('partial account failures preserve the last complete provider average as stale and recover on success', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 });
  let failing = false;
  let firstUsage = 20;
  const url = await serve(t, request => {
    if (request.path.endsWith('auth-files')) return { body: { files: files.slice(0, 2) } };
    const first = record(request.body)?.auth_index === 'x1';
    return { body: { status_code: !first && failing ? 429 : 200, body: weekly(first ? firstUsage : 80) } };
  });
  const monitor = new QuotaMonitor(new CLIProxyClient(url, 'test-key'), () => {});
  t.after(() => monitor.dispose());
  await monitor.refresh();
  const old = monitor.state[1]!.summary;
  assert.equal(old?.used, 50);
  failing = true;
  firstUsage = 40;
  await monitor.refresh();
  assert.deepEqual(monitor.state[1]!.summary, old);
  assert.match(monitor.state[1]!.error!, /could not be refreshed/);
  assert.equal(monitor.state[1]!.accounts[0]!.windows[0]?.used, 40);
  assert.equal(monitor.state[1]!.accounts[1]!.windows[0]?.used, 80);
  assert.match(monitor.state[1]!.accounts[1]!.error!, /429/);
  failing = false;
  t.mock.timers.tick(300000);
  await monitor.refresh();
  assert.equal(monitor.state[1]!.summary?.used, 60);
  assert.equal(monitor.state[1]!.error, undefined);
  assert.ok(monitor.state[1]!.accounts.every(a => !a.error));
});

test('discovery failure retains stale readings, while removed accounts disappear after successful discovery', async t => {
  let fail = false;
  let currentFiles = files.slice(0, 2);
  const url = await serve(t, request => request.path.endsWith('auth-files')
    ? { status: fail ? 503 : 200, body: { files: currentFiles } }
    : { body: { status_code: 200, body: weekly(record(request.body)?.auth_index === 'x1' ? 20 : 80) } });
  const monitor = new QuotaMonitor(new CLIProxyClient(url, 'test-key'), () => {});
  t.after(() => monitor.dispose());
  await monitor.refresh();
  fail = true;
  await monitor.refresh();
  assert.equal(monitor.state[1]?.summary?.used, 50);
  assert.match(monitor.state[1]!.error!, /503/);
  assert.ok(monitor.state[1]!.accounts.every(a => a.error));
  fail = false;
  currentFiles = files.slice(0, 1);
  await monitor.refresh();
  assert.equal(monitor.state[1]?.summary?.used, 20);
  assert.equal(monitor.state[1]?.accounts.length, 1);
  currentFiles = [];
  await monitor.refresh();
  assert.equal(monitor.state[1]?.summary, undefined);
  assert.deepEqual(monitor.state[1]?.accounts, []);
  assert.equal(monitor.state[1]?.error, undefined);
});

test('refresh defaults to five minutes and overlapping refreshes do not duplicate requests', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1800000000000 });
  let discoveries = 0;
  let release: (() => void) | undefined;
  let hold = false;
  const url = await serve(t, async () => {
    discoveries++;
    if (hold) await new Promise<void>(resolve => { release = resolve; });
    return { body: { files: [] } };
  });
  const monitor = new QuotaMonitor(new CLIProxyClient(url, 'test-key'), () => {});
  t.after(() => monitor.dispose());
  monitor.start();
  await monitor.refresh();
  assert.equal(discoveries, 1);
  t.mock.timers.tick(299999);
  assert.equal(monitor.refreshing, false);
  assert.equal(discoveries, 1);
  t.mock.timers.tick(1);
  assert.equal(monitor.refreshing, true);
  await monitor.refresh();
  assert.equal(discoveries, 2);
  hold = true;
  const first = monitor.refresh();
  const second = monitor.refresh();
  assert.equal(first, second);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(300000);
  assert.equal(discoveries, 3);
  release();
  await first;
  assert.equal(monitor.refreshing, false);
  monitor.dispose();
  t.mock.timers.tick(300000);
  assert.equal(discoveries, 3);
});

test('disposing during a request prevents late updates', async t => {
  let requested: (() => void) | undefined;
  const received = new Promise<void>(resolve => { requested = resolve; });
  const url = await serve(t, () => { requested!(); return { hang: true }; });
  let updates = 0;
  const monitor = new QuotaMonitor(new CLIProxyClient(url, 'test-key'), () => { updates++; });
  t.after(() => monitor.dispose());
  const pending = monitor.refresh();
  await received;
  assert.equal(updates, 1);
  monitor.dispose();
  await pending;
  assert.equal(updates, 1);
  assert.equal(monitor.state[1]?.summary, undefined);
});
