import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLIProxyClient } from '../src/client';
import { QuotaMonitor, refreshIntervalFromMinutes } from '../src/monitor';
import { record, parsePlanCapacities } from '../src/quota';
import { serve, weekly } from './server';

const files = [
  { name: 'x1', type: 'codex', auth_index: 'x1', id_token: { plan_type: 'team' } },
  { name: 'x2', type: 'codex', auth_index: 'x2', id_token: { plan_type: 'team' } },
  { name: 'c', type: 'claude', auth_index: 'c' },
];

test('provider refresh requests only that provider and preserves other provider readings and freshness', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 });
  const calls: string[] = [];
  let used = 20;
  const url = await serve(t, request => {
    if (request.path.endsWith('auth-files')) return { body: { files } };
    const id = String(record(request.body)?.auth_index);
    calls.push(id);
    return { body: { status_code: 200, body: id === 'c' ? { five_hour: { utilization: used } } : weekly(used) } };
  });
  const monitor = new QuotaMonitor(new CLIProxyClient(url, 'test-key'), () => {});
  t.after(() => monitor.dispose());
  await monitor.refresh();
  const claude = structuredClone(monitor.state[0]);
  const lastAttempt = monitor.lastAttempt;
  calls.length = 0;
  used = 60;
  t.mock.timers.tick(1000);
  await monitor.refresh('manual', { provider: 'codex' });
  assert.deepEqual(calls.sort(), ['x1', 'x2']);
  assert.deepEqual(monitor.state[0], claude);
  assert.equal(monitor.state[1]?.summary?.used, 60);
  assert.equal(monitor.lastAttempt, lastAttempt);
  assert.equal(monitor.lastCheckedAt, 1800000001000);
});

test('account refresh updates only the selected account and recalculates its provider total', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 });
  const calls: string[] = [];
  let used = 20;
  let failing = false;
  const url = await serve(t, request => {
    if (request.path.endsWith('auth-files')) return { body: { files: files.slice(0, 2) } };
    calls.push(String(record(request.body)?.auth_index));
    return { body: { status_code: failing ? 503 : 200, body: weekly(used) } };
  });
  const monitor = new QuotaMonitor(new CLIProxyClient(url, 'test-key'), () => {});
  t.after(() => monitor.dispose());
  await monitor.refresh();
  const other = structuredClone(monitor.state[1]!.accounts[1]);
  const target = { provider: 'codex' as const, accountId: monitor.state[1]!.accounts[0]!.account.id };
  calls.length = 0;
  used = 60;
  t.mock.timers.tick(1000);
  await monitor.refresh('manual', target);
  assert.deepEqual(calls, ['x1']);
  assert.equal(monitor.state[1]?.summary?.used, 40);
  assert.equal(monitor.state[1]?.summary?.updatedAt, 1800000000000);
  assert.equal(monitor.state[1]?.accounts[0]?.updatedAt, 1800000001000);
  assert.deepEqual(monitor.state[1]?.accounts[1], other);
  failing = true;
  await monitor.refresh('manual', target);
  assert.equal(monitor.state[1]?.summary?.used, 40);
  assert.match(monitor.state[1]!.accounts[0]!.error!, /503/);
  assert.deepEqual(monitor.state[1]?.accounts[1], other);
});

test('scoped discovery failure leaves unrelated accounts untouched and removed accounts disappear only in scope', async t => {
  let fail = false;
  let currentFiles = files;
  const url = await serve(t, request => {
    if (request.path.endsWith('auth-files')) return { status: fail ? 503 : 200, body: { files: currentFiles } };
    return { body: { status_code: 200, body: record(request.body)?.auth_index === 'c'
      ? { five_hour: { utilization: 20 } } : weekly(20) } };
  });
  const monitor = new QuotaMonitor(new CLIProxyClient(url, 'test-key'), () => {});
  t.after(() => monitor.dispose());
  await monitor.refresh();
  const claude = structuredClone(monitor.state[0]);
  const other = structuredClone(monitor.state[1]!.accounts[1]);
  const target = { provider: 'codex' as const, accountId: monitor.state[1]!.accounts[0]!.account.id };
  fail = true;
  await monitor.refresh('manual', target);
  assert.match(monitor.state[1]!.accounts[0]!.error!, /503/);
  assert.deepEqual(monitor.state[1]?.accounts[1], other);
  assert.deepEqual(monitor.state[0], claude);
  fail = false;
  currentFiles = [];
  await monitor.refresh('manual', target);
  assert.deepEqual(monitor.state[1]?.accounts, [other]);
  assert.equal(monitor.state[1]?.summary?.used, 20);
  assert.equal(monitor.state[1]?.error, undefined);
  assert.deepEqual(monitor.state[0], claude);
  await monitor.refresh('manual');
  assert.ok(monitor.state.every(p => p.accounts.length === 0 && !p.summary));
});

test('different refresh targets and Refresh All queued during a refresh are all fulfilled', async t => {
  let hold = false;
  let release: (() => void) | undefined;
  const calls: string[] = [];
  const url = await serve(t, async request => {
    if (request.path.endsWith('auth-files')) {
      if (hold) await new Promise<void>(resolve => { release = resolve; });
      return { body: { files: files.slice(0, 2) } };
    }
    calls.push(String(record(request.body)?.auth_index));
    return { body: { status_code: 200, body: weekly(20) } };
  });
  const monitor = new QuotaMonitor(new CLIProxyClient(url, 'test-key'), () => {});
  t.after(() => monitor.dispose());
  await monitor.refresh();
  calls.length = 0;
  hold = true;
  const firstTarget = { provider: 'codex' as const, accountId: monitor.state[1]!.accounts[0]!.account.id };
  const first = monitor.refresh('manual', firstTarget);
  const repeated = monitor.refresh('manual', firstTarget);
  assert.equal(first, repeated);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const second = monitor.refresh('manual', { provider: 'codex', accountId: monitor.state[1]!.accounts[1]!.account.id });
  const all = monitor.refresh('manual');
  hold = false;
  release();
  await Promise.all([first, repeated, second, all]);
  assert.deepEqual(calls.sort(), ['x1', 'x1', 'x2', 'x2']);
  assert.equal(monitor.refreshing, false);
});

test('mixed Claude Max 5x and Max 20x accounts have separate weighted five-hour and Fable totals', async t => {
  const url = await serve(t, request => {
    if (request.path.endsWith('auth-files')) return { body: { files: [
      { name: 'a.json', type: 'claude', auth_index: 'a' }, { name: 'b.json', type: 'claude', auth_index: 'b' },
    ] } };
    const body = record(request.body);
    const first = body?.auth_index === 'a';
    return { body: { status_code: 200, body: String(body?.url).endsWith('/profile')
      ? { organization: { rate_limit_tier: first ? 'default_claude_max_5x' : 'default_claude_max_20x' } }
      : { five_hour: { utilization: first ? 20 : 40 }, limits: [
        { kind: 'weekly_scoped', scope: { model: { display_name: 'Fable' } }, percent: first ? 50 : 80, is_active: true },
      ] } } };
  });
  const monitor = new QuotaMonitor(new CLIProxyClient(url, 'test-key'), () => {});
  t.after(() => monitor.dispose());
  await monitor.refresh();
  const claude = monitor.state[0]!;
  assert.equal(claude.summary?.totalUnits, 125);
  assert.equal(claude.summary?.remainingUnits, 80);
  assert.equal(claude.summary?.used, 36);
  assert.equal(claude.fableSummary?.totalUnits, 125);
  assert.equal(claude.fableSummary?.remainingUnits, 32.5);
  assert.equal(claude.fableSummary?.used, 74);
});

test('an account upgrade or downgrade uses the live quota plan rather than stale auth-file metadata', async t => {
  let livePlan = 'prolite';
  let failFirst = false;
  const url = await serve(t, request => {
    if (request.path.endsWith('auth-files')) return { body: { files: files.slice(0, 2).map(file => ({ ...file, id_token: { plan_type: 'prolite' } })) } };
    const first = record(request.body)?.auth_index === 'x1';
    return { body: first && failFirst ? { status_code: 503, body: {} }
      : { status_code: 200, body: { ...weekly(first ? 20 : 80), plan_type: first ? livePlan : 'prolite' } } };
  });
  const monitor = new QuotaMonitor(new CLIProxyClient(url, 'test-key'), () => {});
  t.after(() => monitor.dispose());
  await monitor.refresh();
  assert.equal(monitor.state[1]?.summary?.totalUnits, 200);
  assert.equal(monitor.state[1]?.summary?.remainingUnits, 100);
  livePlan = 'team';
  await monitor.refresh('manual');
  assert.equal(monitor.state[1]?.accounts[0]?.account.planType, 'team');
  assert.equal(monitor.state[1]?.summary?.totalUnits, 120);
  assert.equal(monitor.state[1]?.summary?.remainingUnits, 36);
  livePlan = 'pro';
  await monitor.refresh('manual');
  assert.equal(monitor.state[1]?.accounts[0]?.account.planType, 'pro');
  assert.equal(monitor.state[1]?.summary?.totalUnits, 125);
  assert.equal(monitor.state[1]?.summary?.remainingUnits, 85);
  failFirst = true;
  await monitor.refresh('manual');
  assert.equal(monitor.state[1]?.accounts[0]?.account.planType, 'pro');
  assert.equal(monitor.state[1]?.summary?.remainingUnits, 85);
  assert.ok(monitor.state[1]?.error);
});

test('editing plan capacities recalculates cached totals without another quota request', async t => {
  let calls = 0;
  const url = await serve(t, request => {
    if (request.path.endsWith('auth-files')) return { body: { files: files.slice(0, 2) } };
    calls++;
    const first = record(request.body)?.auth_index === 'x1';
    return { body: { status_code: 200, body: { ...weekly(first ? 20 : 80), plan_type: first ? 'prolite' : 'team' } } };
  });
  const monitor = new QuotaMonitor(new CLIProxyClient(url, 'test-key'), () => {});
  t.after(() => monitor.dispose());
  await monitor.refresh();
  assert.equal(monitor.state[1]?.summary?.remainingUnits, 84);
  const checkedAt = monitor.lastCheckedAt;
  monitor.setCapacityPolicy({ planCapacities: parsePlanCapacities({ codex: { prolite: 10 } }) });
  assert.equal(calls, 2);
  assert.equal(monitor.state[1]?.summary?.totalUnits, 110);
  assert.equal(monitor.state[1]?.summary?.remainingUnits, 82);
  assert.equal(monitor.lastCheckedAt, checkedAt);
});

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
