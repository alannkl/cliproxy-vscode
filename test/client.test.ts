import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLIProxyClient, normalizeBaseUrl } from '../src/client';
import { record } from '../src/quota';
import { serve, TestRequest, weekly } from './server';

const signal = () => new AbortController().signal;

test('Claude quota reads the precise profile tier for each account and detects tier changes', async t => {
  let tier = 'default_claude_max_5x';
  const requests: TestRequest[] = [];
  const url = await serve(t, request => {
    requests.push(request);
    return { body: { status_code: 200, body: String(record(request.body)?.url).endsWith('/profile')
      ? { organization: { rate_limit_tier: tier } } : { five_hour: { utilization: 2 } } } };
  });
  const client = new CLIProxyClient(url, 'test-key');
  const account = { id: 'c', name: 'c', provider: 'claude' as const, authIndex: 'c', disabled: false };
  assert.equal((await client.quota(account, signal())).planType, 'default_claude_max_5x');
  tier = 'default_claude_max_20x';
  assert.equal((await client.quota(account, signal())).planType, 'default_claude_max_20x');
  assert.equal(requests.length, 4);
  assert.deepEqual(requests[1]?.body, { auth_index: 'c', method: 'GET', url: 'https://api.anthropic.com/api/oauth/profile',
    header: { Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json', 'anthropic-beta': 'oauth-2025-04-20' } });
});

test('a failed Claude profile lookup keeps valid quota windows and does not guess a Max tier', async t => {
  let status = 503;
  const url = await serve(t, request => ({ body: String(record(request.body)?.url).endsWith('/profile')
    ? { status_code: status, body: { account: { has_claude_max: true }, organization: { organization_type: 'claude_max' } } }
    : { status_code: 200, body: { five_hour: { utilization: 2 } } } }));
  const client = new CLIProxyClient(url, 'test-key');
  const account = { id: 'c', name: 'c', provider: 'claude' as const, authIndex: 'c', disabled: false };
  const reading = await client.quota(account, signal());
  assert.equal(reading.windows[0]?.used, 2);
  assert.equal(reading.planType, undefined);
  status = 200;
  assert.equal((await client.quota(account, signal())).planType, undefined);
});

test('manual quota refresh retries a locally paused account and clears the cooldown on success', async t => {
  let calls = 0;
  const url = await serve(t, () => ({ body: ++calls === 1
    ? { status_code: 429, header: { 'Retry-After': ['0'] }, body: {} }
    : { status_code: 200, body: weekly(2) } }));
  const client = new CLIProxyClient(url, 'test-key');
  const account = { id: 'x', name: 'x', provider: 'codex' as const, authIndex: 'x', disabled: false };
  await assert.rejects(client.quota(account, signal()), /429/);
  await assert.rejects(client.quota(account, signal()), /429/);
  assert.equal(calls, 1);
  assert.equal((await client.quota(account, signal(), 'manual')).windows[0]?.used, 2);
  assert.equal(calls, 2);
  assert.equal((await client.quota(account, signal())).windows[0]?.used, 2);
  assert.equal(calls, 3);
});

test('manual quota refresh still respects a future Retry-After requested by the provider', async t => {
  let calls = 0;
  const url = await serve(t, () => { calls++; return { body: { status_code: 429, header: { 'Retry-After': ['120'] }, body: {} } }; });
  const client = new CLIProxyClient(url, 'test-key');
  const account = { id: 'x', name: 'x', provider: 'codex' as const, authIndex: 'x', disabled: false };
  await assert.rejects(client.quota(account, signal()), /429/);
  await assert.rejects(client.quota(account, signal(), 'manual'), /429/);
  assert.equal(calls, 1);
});

test('a quota 429 honors Retry-After and suppresses repeated requests until that time', async t => {
  const now = 1800000000000;
  t.mock.timers.enable({ apis: ['Date'], now });
  for (const retry of ['120', new Date(now + 120000).toUTCString()]) {
    t.mock.timers.setTime(now);
    let calls = 0;
    const url = await serve(t, () => ({ body: ++calls === 1
      ? { status_code: 429, header: { 'Retry-After': [retry] }, body: 'secret-echo' }
      : { status_code: 200, body: weekly(12) } }));
    const client = new CLIProxyClient(url, 'test-key');
    const account = { id: 'x', name: 'x', provider: 'codex' as const, authIndex: 'x', disabled: false };
    await assert.rejects(client.quota(account, signal()), /429.*Checks paused/);
    t.mock.timers.tick(119999);
    await assert.rejects(client.quota(account, signal()), /Checks paused/);
    assert.equal(calls, 1);
    t.mock.timers.tick(1);
    assert.equal((await client.quota(account, signal())).windows[0]?.used, 12);
    assert.equal(calls, 2);
  }
});

test('missing or zero Retry-After uses a five-minute cooldown that increases on repeated 429s and resets after success', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 });
  let calls = 0;
  let limited = true;
  const url = await serve(t, () => {
    calls++;
    return { body: limited ? { status_code: 429, header: calls % 2 ? { 'retry-after': ['0'] } : {}, body: {} }
      : { status_code: 200, body: weekly(12) } };
  });
  const client = new CLIProxyClient(url, 'test-key');
  const account = { id: 'x', name: 'x', provider: 'codex' as const, authIndex: 'x', disabled: false };
  for (const delay of [300000, 600000, 1200000, 1800000, 1800000]) {
    await assert.rejects(client.quota(account, signal()), /429/);
    const previousCalls = calls;
    t.mock.timers.tick(delay - 1);
    await assert.rejects(client.quota(account, signal()), /Checks paused/);
    assert.equal(calls, previousCalls);
    t.mock.timers.tick(1);
  }
  limited = false;
  assert.equal((await client.quota(account, signal())).windows[0]?.used, 12);
  limited = true;
  await assert.rejects(client.quota(account, signal()), /429/);
  limited = false;
  t.mock.timers.tick(300000);
  assert.equal((await client.quota(account, signal())).windows[0]?.used, 12);
});

test('management requests authenticate and proxy quota GETs with the selected auth index and token placeholder', async t => {
  const requests: TestRequest[] = [];
  const url = await serve(t, request => {
    requests.push(request);
    if (request.path.endsWith('auth-files')) return { body: { files: [
      { name: 'codex.json', type: 'codex', auth_index: 'x', id_token: { chatgpt_account_id: 'team' } },
      { name: 'claude.json', type: 'claude', auth_index: 'c' },
    ] } };
    return { body: { status_code: 200, body: record(request.body)?.auth_index === 'x'
      ? JSON.stringify(weekly(12)) : { five_hour: { utilization: 45, resets_at: null } } } };
  });
  const client = new CLIProxyClient(`${url}/v0/management/`, 'test-management-key');
  const accounts = await client.accounts(signal());
  const codex = accounts.find(a => a.provider === 'codex')!;
  const claude = accounts.find(a => a.provider === 'claude')!;
  assert.equal((await client.quota(codex, signal())).windows[0]?.used, 12);
  assert.equal((await client.quota(claude, signal())).windows[0]?.used, 45);
  assert.deepEqual(requests.map(r => [r.method, r.path, r.headers.authorization]), [
    ['GET', '/v0/management/auth-files', 'Bearer test-management-key'],
    ['POST', '/v0/management/api-call', 'Bearer test-management-key'],
    ['POST', '/v0/management/api-call', 'Bearer test-management-key'],
    ['POST', '/v0/management/api-call', 'Bearer test-management-key'],
  ]);
  assert.deepEqual(requests[1]?.body, { auth_index: 'x', method: 'GET',
    url: 'https://chatgpt.com/backend-api/wham/usage', header: { Authorization: 'Bearer $TOKEN$',
      'Content-Type': 'application/json', 'User-Agent': 'codex-tui/0.149.1', 'Chatgpt-Account-Id': 'team' } });
  assert.deepEqual(requests[2]?.body, { auth_index: 'c', method: 'GET',
    url: 'https://api.anthropic.com/api/oauth/usage', header: { Authorization: 'Bearer $TOKEN$',
      'Content-Type': 'application/json', 'anthropic-beta': 'oauth-2025-04-20' } });
  await assert.rejects(client.quota({ ...codex, authIndex: undefined }, signal()), /no auth_index/);
  assert.equal(requests.length, 4);
});

test('both HTTP failures and errors wrapped in HTTP 200 are rejected without leaking response bodies', async t => {
  let mode = 'outer';
  const url = await serve(t, () => mode === 'outer' ? { status: 401, body: { error: 'secret-echo' } }
    : { body: { status_code: 429, body: 'secret-echo' } });
  const client = new CLIProxyClient(url, 'test-key');
  await assert.rejects(client.accounts(signal()), { message: 'Management API returned HTTP 401. Check the management key.' });
  mode = 'inner';
  await assert.rejects(client.quota({ id: 'x', name: 'x', provider: 'codex', authIndex: 'x', disabled: false }, signal()),
    error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Provider quota API returned HTTP 429\. Checks paused/);
      assert.doesNotMatch(error.message, /secret-echo/);
      return true;
    });
});

test('redirects are not followed and timed-out requests are aborted', async t => {
  let destinationCalls = 0;
  const destination = await serve(t, () => { destinationCalls++; return { body: { files: [] } }; });
  const redirect = await serve(t, () => ({ status: 302, headers: { Location: destination }, body: {} }));
  await assert.rejects(new CLIProxyClient(redirect, 'test-key').accounts(signal()), /Redirects are not followed/);
  assert.equal(destinationCalls, 0);
  const hanging = await serve(t, () => ({ hang: true }));
  await assert.rejects(new CLIProxyClient(hanging, 'test-key', 40).accounts(signal()), /timed out/);
});

test('invalid management URLs and malformed auth lists are rejected', async t => {
  assert.equal(normalizeBaseUrl(' http://vm:8317/v0/management/ '), 'http://vm:8317');
  assert.equal(normalizeBaseUrl('https://vm/proxy/'), 'https://vm/proxy');
  for (const url of ['oops', 'file:///tmp/foo', 'https://user:password@vm', 'http://vm?key=x', 'http://vm#x']) {
    assert.throws(() => normalizeBaseUrl(url));
  }
  assert.throws(() => new CLIProxyClient('http://vm', ' '), /management key/);
  const url = await serve(t, () => ({ body: { unexpected: [] } }));
  await assert.rejects(new CLIProxyClient(url, 'test-key').accounts(signal()), /files array/);
});
