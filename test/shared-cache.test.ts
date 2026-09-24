import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import lockfile from 'proper-lockfile';
import { CLIProxyClient, RefreshMode } from '../src/client';
import { QuotaMonitor, ProviderQuota } from '../src/monitor';
import { SharedQuotaCache } from '../src/shared-cache';
import { record } from '../src/quota';
import { serve, weekly } from './server';

const files = [{ name: 'a.json', type: 'codex', auth_index: 'a', id_token: { plan_type: 'prolite' } }];

test('concurrent scoped refreshes across windows preserve both updates without satisfying unrelated targets', async t => {
  const path = await directory(t);
  const calls: string[] = [];
  let used = 20;
  const url = await serve(t, async request => {
    if (request.path.endsWith('auth-files')) return { body: { files: [
      ...files, { ...files[0], name: 'b.json', auth_index: 'b' },
    ] } };
    calls.push(String(record(request.body)?.auth_index));
    await delay(100);
    return { body: { status_code: 200, body: weekly(used) } };
  });
  const first = windowMonitor(t, url, path), second = windowMonitor(t, url, path);
  await first.refresh();
  await second.refresh();
  const a = { provider: 'codex' as const, accountId: first.state[1]!.accounts[0]!.account.id };
  const b = { provider: 'codex' as const, accountId: first.state[1]!.accounts[1]!.account.id };
  used = 60;
  calls.length = 0;
  await Promise.all([first.refresh('manual', a), second.refresh('manual', b)]);
  assert.deepEqual(calls.sort(), ['a', 'b']);
  await first.refresh();
  await second.refresh();
  assert.equal(first.state[1]?.summary?.used, 60);
  assert.deepEqual(second.state, first.state);
  calls.length = 0;
  await Promise.all([first.refresh('manual', a), second.refresh('manual', a)]);
  assert.deepEqual(calls, ['a']);
  calls.length = 0;
  const scoped = first.refresh('manual', a);
  await eventually(() => calls.length === 1);
  const all = second.refresh('manual');
  await Promise.all([scoped, all]);
  assert.deepEqual(calls.sort(), ['a', 'a', 'b']);
});

test('a scoped refresh does not postpone a due automatic refresh of all accounts', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 });
  const path = await directory(t);
  const calls: string[] = [];
  const url = await serve(t, request => {
    if (request.path.endsWith('auth-files')) return { body: { files: [
      ...files, { ...files[0], name: 'b.json', auth_index: 'b' },
    ] } };
    calls.push(String(record(request.body)?.auth_index));
    return { body: { status_code: 200, body: weekly(20) } };
  });
  const first = windowMonitor(t, url, path);
  await first.refresh();
  const fullAttempt = first.lastAttempt;
  calls.length = 0;
  t.mock.timers.tick(300001);
  await first.refresh('manual', { provider: 'codex', accountId: first.state[1]!.accounts[0]!.account.id });
  assert.deepEqual(calls, ['a']);
  assert.equal(first.lastAttempt, fullAttempt);
  const second = windowMonitor(t, url, path);
  await second.refresh();
  assert.deepEqual(calls.sort(), ['a', 'a', 'b']);
  assert.equal(second.lastAttempt, 1800000300001);
});

test('two windows share both usage and profile requests for multiple Claude accounts', async t => {
  const path = await directory(t);
  let usageCalls = 0;
  let profileCalls = 0;
  const url = await serve(t, request => {
    if (request.path.endsWith('auth-files')) return { body: { files: [
      { name: 'a.json', type: 'claude', auth_index: 'a' }, { name: 'b.json', type: 'claude', auth_index: 'b' },
    ] } };
    const body = record(request.body);
    if (String(body?.url).endsWith('/profile')) {
      profileCalls++;
      return { body: { status_code: 200, body: { organization: { rate_limit_tier: body?.auth_index === 'a'
        ? 'default_claude_max_5x' : 'default_claude_max_20x' } } } };
    }
    usageCalls++;
    return { body: { status_code: 200, body: { five_hour: { utilization: 20 }, limits: [
      { kind: 'weekly_scoped', scope: { model: { display_name: 'Fable' } }, percent: 40, is_active: true },
    ] } } };
  });
  const first = windowMonitor(t, url, path), second = windowMonitor(t, url, path);
  await Promise.all([first.refresh(), second.refresh()]);
  assert.equal(usageCalls, 2);
  assert.equal(profileCalls, 2);
  assert.equal(second.state[0]?.summary?.totalUnits, 125);
  assert.equal(second.state[0]?.summary?.remainingUnits, 100);
  assert.equal(second.state[0]?.fableSummary?.remainingUnits, 75);
});

test('a later manual refresh fetches again even when the clock has not advanced a millisecond', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const path = await directory(t);
  let calls = 0;
  const url = await serve(t, request => {
    if (request.path.endsWith('auth-files')) return { body: { files } };
    return { body: { status_code: 200, body: weekly(++calls === 1 ? 20 : 40) } };
  });
  await windowMonitor(t, url, path).refresh();
  const next = windowMonitor(t, url, path);
  await next.refresh('manual');
  assert.equal(calls, 2);
  assert.equal(next.state[1]?.summary?.used, 40);
});

test('Fable quota survives shared-cache reads and remains cached after a failed refresh', async t => {
  const path = await directory(t);
  let calls = 0;
  let fail = false;
  const url = await serve(t, request => {
    if (request.path.endsWith('auth-files')) return { body: { files: [{ name: 'claude.json', type: 'claude', auth_index: 'c' }] } };
    if (String(record(request.body)?.url).endsWith('/profile')) return { body: { status_code: 200,
      body: { organization: { rate_limit_tier: 'default_claude_max_20x' } } } };
    calls++;
    return { body: fail ? { status_code: 503, body: {} } : { status_code: 200, body: {
      five_hour: { utilization: 2 }, seven_day: { utilization: 4 },
      limits: [{ kind: 'weekly_scoped', scope: { model: { display_name: 'Fable' } }, percent: 6, is_active: true }],
    } } };
  });
  const first = windowMonitor(t, url, path);
  await first.refresh();
  const second = windowMonitor(t, url, path);
  await second.refresh();
  assert.equal(calls, 1);
  assert.equal(second.state[0]?.fableSummary?.remainingUnits, 94);
  assert.equal(second.state[0]?.accounts[0]?.windows.find(w => w.kind === 'fable')?.used, 6);
  fail = true;
  await first.refresh('manual');
  await second.refresh();
  assert.equal(calls, 2);
  assert.equal(second.state[0]?.fableSummary?.remainingUnits, 94);
  assert.ok(second.state[0]?.error);
});

test('manual refresh joins another process that is already fetching a successful automatic result', async t => {
  const path = await directory(t);
  let calls = 0;
  const url = await serve(t, async request => {
    if (request.path.endsWith('auth-files')) return { body: { files } };
    calls++;
    await delay(350);
    return { body: { status_code: 200, body: weekly(10) } };
  });
  const owner = worker(t, url, path);
  await eventually(() => calls === 1);
  const manual = windowMonitor(t, url, path);
  await manual.refresh('manual');
  await owner.done;
  assert.equal(calls, 1);
  assert.equal(manual.state[1]?.summary?.remainingUnits, 90);
});

async function directory(t: TestContext): Promise<string> {
  const path = await fs.mkdtemp(join(tmpdir(), 'cliproxy-cache-test-'));
  t.after(() => fs.rm(path, { recursive: true, force: true }));
  return path;
}

function windowMonitor(t: TestContext, url: string, path: string, onChange = () => {}): QuotaMonitor {
  const client = new CLIProxyClient(url, 'test-key');
  const monitor = new QuotaMonitor(client, onChange, 300000, { sharedCache: new SharedQuotaCache(path, client.cacheKey) });
  t.after(() => monitor.dispose());
  return monitor;
}

function worker(t: TestContext, url: string, path: string, mode: RefreshMode = 'automatic', startAt = Date.now()) {
  const child = spawn(process.execPath, [join(__dirname, 'cache-worker.js'), url, path, mode, String(startAt)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  const done = new Promise<{ state: ProviderQuota[]; lastCheckedAt: number }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) reject(new Error('Worker exited before completing.'));
      else { try { resolve(JSON.parse(output)); } catch { reject(new Error('Invalid worker output.')); } }
    });
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  return { child, done };
}

async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Expected shared state update did not arrive.');
    await delay(20);
  }
}

test('separate processes sharing one connection perform one quota refresh and reuse its snapshot', async t => {
  const path = await directory(t);
  let discoveries = 0;
  let quotas = 0;
  const url = await serve(t, async request => {
    if (request.path.endsWith('auth-files')) { discoveries++; return { body: { files } }; }
    quotas++;
    await delay(350);
    return { body: { status_code: 200, body: weekly(22) } };
  });
  const startAt = Date.now() + 400;
  const results = await Promise.all(Array.from({ length: 3 }, () => worker(t, url, path, 'automatic', startAt).done));
  assert.equal(discoveries, 1);
  assert.equal(quotas, 1);
  for (const result of results) assert.equal(result.state[1]?.summary?.remainingUnits, 78);
  assert.equal(new Set(results.map(r => r.lastCheckedAt)).size, 1);
  const contents = await fs.readFile(new SharedQuotaCache(path, new CLIProxyClient(url, 'test-key').cacheKey).path, 'utf8');
  assert.ok(!contents.includes('test-key'));
});

test('concurrent manual refreshes share one fetch while a later manual refresh fetches again', async t => {
  const path = await directory(t);
  let calls = 0;
  const url = await serve(t, async request => {
    if (request.path.endsWith('auth-files')) return { body: { files } };
    calls++;
    await delay(350);
    return { body: { status_code: 200, body: weekly(22) } };
  });
  await worker(t, url, path).done;
  const startAt = Date.now() + 400;
  await Promise.all(Array.from({ length: 3 }, () => worker(t, url, path, 'manual', startAt).done));
  assert.equal(calls, 2);
  await worker(t, url, path, 'manual').done;
  assert.equal(calls, 3);
});

test('cache changes update another window without another provider request', async t => {
  const path = await directory(t);
  let calls = 0;
  const url = await serve(t, request => {
    if (request.path.endsWith('auth-files')) return { body: { files } };
    return { body: { status_code: 200, body: weekly(++calls === 1 ? 20 : 40) } };
  });
  const first = windowMonitor(t, url, path);
  first.start();
  await first.refresh();
  const second = windowMonitor(t, url, path);
  await second.refresh('manual');
  assert.equal(calls, 2);
  await eventually(() => first.state[1]?.summary?.used === 40);
  assert.equal(calls, 2);
  assert.equal(first.lastCheckedAt, second.lastCheckedAt);
});

test('shared cooldowns survive a new client and manual refresh can recover from a local pause', async t => {
  const path = await directory(t);
  let calls = 0;
  const url = await serve(t, request => {
    if (request.path.endsWith('auth-files')) return { body: { files } };
    calls++;
    return { body: calls === 1 ? { status_code: 429, header: { 'Retry-After': ['0'] }, body: {} }
      : { status_code: 200, body: weekly(2) } };
  });
  const first = windowMonitor(t, url, path);
  await first.refresh();
  assert.ok(first.state[1]?.error);
  const cache = new SharedQuotaCache(path, new CLIProxyClient(url, 'test-key').cacheKey);
  const snapshot = (await cache.read())!;
  snapshot.lastCheckedAt = Date.now() - 300001;
  await fs.writeFile(cache.path, JSON.stringify(snapshot));
  const second = windowMonitor(t, url, path);
  await second.refresh();
  assert.equal(calls, 1);
  assert.match(second.state[1]!.accounts[0]!.error!, /paused locally/);
  await second.refresh('manual');
  assert.equal(calls, 2);
  assert.equal(second.state[1]?.summary?.remainingUnits, 98);
  assert.equal(second.state[1]?.error, undefined);
});

test('an expired lock from a terminated owner is recovered without overlapping requests', async t => {
  const path = await directory(t);
  let calls = 0;
  const url = await serve(t, request => {
    if (request.path.endsWith('auth-files')) return { body: { files } };
    calls++;
    return calls === 1 ? { hang: true } : { body: { status_code: 200, body: weekly(10) } };
  });
  const owner = worker(t, url, path);
  const stopped = owner.done.catch(() => undefined);
  await eventually(() => calls === 1);
  owner.child.kill('SIGKILL');
  await stopped;
  const cache = new SharedQuotaCache(path, new CLIProxyClient(url, 'test-key').cacheKey);
  const expired = new Date(Date.now() - 130000);
  await fs.utimes(`${cache.path}.lock`, expired, expired);
  const recovered = await worker(t, url, path).done;
  assert.equal(recovered.state[1]?.summary?.remainingUnits, 90);
  assert.equal(calls, 2);
});

test('different connection identities are isolated and corrupted snapshots are ignored', async t => {
  const path = await directory(t);
  const first = new CLIProxyClient('http://example.test:8317', 'one-key');
  const second = new CLIProxyClient('http://example.test:8317', 'two-key');
  const otherHost = new CLIProxyClient('http://other.test:8317', 'one-key');
  assert.notEqual(first.cacheKey, second.cacheKey);
  assert.notEqual(first.cacheKey, otherHost.cacheKey);
  const cache = new SharedQuotaCache(path, first.cacheKey);
  assert.equal(await cache.read(), undefined);
  await fs.writeFile(cache.path, '{');
  assert.equal(await cache.read(), undefined);
  await fs.writeFile(cache.path, JSON.stringify({ version: 1, state: 'wrong' }));
  assert.equal(await cache.read(), undefined);
  const url = await serve(t, request => request.path.endsWith('auth-files')
    ? { body: { files } } : { body: { status_code: 200, body: weekly(20) } });
  const client = new CLIProxyClient(url, 'test-key');
  const liveCache = new SharedQuotaCache(path, client.cacheKey);
  await fs.writeFile(liveCache.path, '{');
  const monitor = windowMonitor(t, url, path);
  await monitor.refresh();
  assert.equal(monitor.state[1]?.summary?.remainingUnits, 80);
  assert.ok(await liveCache.read());
});

test('aborting a lock waiter never starts a provider request', async t => {
  const path = await directory(t);
  const cache = new SharedQuotaCache(path, new CLIProxyClient('http://example.test', 'key').cacheKey);
  const release = await lockfile.lock(cache.path, { realpath: false });
  const controller = new AbortController();
  let called = false;
  const pending = cache.refresh('automatic', 300000, controller.signal, async () => { called = true; throw new Error('Unexpected fetch'); });
  await delay(50);
  controller.abort();
  await assert.rejects(pending);
  assert.equal(called, false);
  await release();
});
