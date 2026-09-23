import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountQuota, averageQuota, parseAccounts, parseQuota, quotaColor, remainingPercent } from '../src/quota';

const account = { id: 'a', name: 'a.json', provider: 'codex' as const, disabled: false };
const codex = (used: unknown, seconds: unknown = 604800) => ({ rate_limit: {
  primary_window: { used_percent: used, limit_window_seconds: seconds, reset_at: 1800000000 },
  secondary_window: null,
} });

test('quota display converts provider and account windows to remaining, including exhaustion and fractional averages', () => {
  const claude = parseQuota('claude', { five_hour: { utilization: 2 }, seven_day: { utilization: 4 } });
  assert.deepEqual(claude.map(w => remainingPercent(w.used)), [98, 96]);
  const codexAccounts = [71, 28, 100].map(used => ({ account, windows: parseQuota('codex', codex(used)) }));
  assert.deepEqual(codexAccounts.map(a => remainingPercent(a.windows[0]!.used)), [29, 72, 0]);
  assert.equal(remainingPercent(averageQuota(codexAccounts, 123)!.used), 34);
  const fractional = [0.4, 0.8].map(used => ({ account, windows: parseQuota('codex', codex(used)) }));
  assert.equal(remainingPercent(averageQuota(fractional, 123)!.used), 99);
  assert.equal(remainingPercent(parseQuota('codex', codex(0))[0]!.used), 100);
});

test('Claude breakdown metadata alongside valid windows does not block quota display or create an extra window', () => {
  const windows = parseQuota('claude', {
    five_hour: { utilization: 2, resets_at: '2026-09-23T12:20:00Z' },
    seven_day: { utilization: 4, resets_at: '2026-09-29T11:00:00Z' },
    seven_day_sonnet: null,
    seven_day_omelette: null,
    seven_day_breakdown: { as_of: '2026-09-23T08:00:00Z', window_started_at: '2026-09-22T11:00:00Z', rows: [] },
  });
  assert.deepEqual(windows.map(w => [w.label, w.used, w.overall]), [['5h', 2, true], ['week', 4, true]]);
  assert.deepEqual(averageQuota([{ account: { ...account, provider: 'claude' }, windows }], 123), {
    used: 2, seconds: 18000, updatedAt: 123,
  });
  assert.throws(() => parseQuota('claude', {
    five_hour: {}, seven_day: { utilization: 4 },
  }), /percentage/);
});

test('weekly-only Codex uses the reported duration, including when it is the primary window', () => {
  assert.deepEqual(parseQuota('codex', JSON.stringify(codex(12))), [{
    label: 'week', seconds: 604800, used: 12, resetAt: 1800000000000, overall: true,
  }]);
  assert.deepEqual(parseQuota('codex', { rateLimit: {
    primaryWindow: { usedPercent: 30, limitWindowSeconds: 18000, resetAfterSeconds: 60 },
    secondaryWindow: { usedPercent: 10, limitWindowSeconds: 604800 },
  } }, 100000).map(w => [w.label, w.used, w.resetAt]), [['5h', 30, 160000], ['week', 10, undefined]]);
});

test('Claude exposes overall and model windows, with the shortest overall window in the status', () => {
  const windows = parseQuota('claude', {
    five_hour: { utilization: 20, resets_at: '2026-10-01T00:00:00Z' },
    seven_day: { utilization: 85, resets_at: null },
    seven_day_sonnet: { utilization: 99, resets_at: null },
    seven_day_opus: null,
    extra_usage: { utilization: 100 },
  });
  assert.deepEqual(windows.map(w => [w.label, w.used, w.overall]), [
    ['5h', 20, true], ['week', 85, true], ['sonnet week', 99, false],
  ]);
  assert.equal(windows[0]?.resetAt, Date.parse('2026-10-01T00:00:00Z'));
  assert.deepEqual(averageQuota([{ account, windows }], 123), { used: 20, seconds: 18000, updatedAt: 123 });
});

test('accounts at 20 and 80 percent used average to 50 percent, without including model-specific quotas', () => {
  const rows = [20, 80].map(used => ({ account, windows: parseQuota('codex', {
    ...codex(used), code_review_rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 18000 } },
    additional_rate_limits: [{ limit_name: 'Spark', rate_limit: {
      primary_window: { used_percent: 1, limit_window_seconds: 604800 },
    } }],
  }) }));
  assert.deepEqual(averageQuota(rows, 123), { used: 50, seconds: 604800, updatedAt: 123 });
  assert.equal(rows[0]?.windows.length, 3);
  assert.equal(averageQuota([], 123), undefined);
});

test('missing, malformed, and mismatched windows never produce a healthy zero or a mixed-period average', () => {
  for (const used of [null, undefined, '', 'oops', -1, 101, NaN, true]) {
    assert.throws(() => parseQuota('codex', codex(used)), /percentage/);
  }
  assert.throws(() => parseQuota('codex', { rate_limit: { primary_window: { used_percent: 5 } } }), /duration/);
  assert.throws(() => parseQuota('codex', { rate_limit: {} }), /No overall/);
  assert.throws(() => parseQuota('claude', { five_hour: {} }), /percentage/);
  assert.throws(() => parseQuota('claude', '<html>'), /JSON/);
  assert.equal(parseQuota('codex', codex('0'))[0]?.used, 0);
  const rows: AccountQuota[] = [
    { account, windows: parseQuota('codex', codex(20)) },
    { account, windows: parseQuota('codex', codex(80, 18000)) },
  ];
  assert.throws(() => averageQuota(rows, 123), /different shortest/);
  assert.throws(() => averageQuota([{ account, windows: [] }], 123), /no overall/);
  assert.throws(() => averageQuota([{ ...rows[0]!, error: 'Failed' }], 123), /could not be refreshed/);
});

test('auth-file parsing keeps supported accounts and resolves the Codex account header', () => {
  const claims = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'jwt-id' } })).toString('base64url');
  const accounts = parseAccounts({ files: [
    { name: 'a.json', type: 'codex', auth_index: 0, id_token: { chatgpt_account_id: 'team-id' } },
    { name: 'b.json', provider: 'claude', authIndex: 'b', disabled: true },
    { name: 'c.json', type: 'gemini' },
    { name: 'd.json', type: 'codex', auth_index: 'd', metadata: { chatgpt_account_id: 'direct-id' } },
    { name: 'e.json', type: 'codex', auth_index: 'e', id_token: `header.${claims}.sig` },
    { name: 'f.json', type: 'claude' },
  ] });
  assert.deepEqual(accounts.map(a => [a.name, a.authIndex, a.accountId, a.disabled]), [
    ['a.json', '0', 'team-id', false], ['b.json', 'b', undefined, true],
    ['d.json', 'd', 'direct-id', false], ['e.json', 'e', 'jwt-id', false],
    ['f.json', undefined, undefined, false],
  ]);
  assert.throws(() => parseAccounts({ files: [{ type: 'codex' }] }), /no name/);
  assert.throws(() => parseAccounts({ files: [
    { name: 'a', type: 'codex', auth_index: 'x' }, { name: 'b', type: 'codex', auth_index: 'x' },
  ] }), /Duplicate/);
});

test('colors warn at 50 and 20 percent remaining, follow displayed rounding, and stale readings are gray', () => {
  assert.deepEqual([0, 49, 50, 79, 80, 100].map(n => quotaColor(n)), ['green', 'green', 'orange', 'orange', 'red', 'red']);
  assert.deepEqual([49.5, 49.51, 79.5, 79.51].map(n => remainingPercent(n)), [51, 50, 21, 20]);
  assert.deepEqual([49.5, 49.51, 79.5, 79.51].map(n => quotaColor(n)), ['green', 'orange', 'orange', 'red']);
  assert.equal(quotaColor(50, true), 'gray');
  assert.equal(quotaColor(undefined), 'gray');
});
