import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountQuota, summarizeQuota, summarizeFableQuota, parseAccountMultipliers, parsePlanCapacities, parseAccounts, parseQuota, quotaColor, remainingColor, remainingPercent } from '../src/quota';
import { statusText } from '../src/presentation';

const account = { id: 'a', name: 'a.json', provider: 'codex' as const, planType: 'team', disabled: false };

test('plan capacities come from a configurable provider registry while account overrides take priority', () => {
  const rows = [
    { account: { ...account, name: 'a', planType: 'prolite' }, windows: parseQuota('codex', codex(20)) },
    { account: { ...account, name: 'b', planType: 'team' }, windows: parseQuota('codex', codex(80)) },
  ];
  const plans = parsePlanCapacities({ codex: { prolite: 10, team: 2, custom: 7 }, claude: { custom: 3 } });
  assert.equal(plans.codex.custom, 7);
  assert.equal(plans.claude.custom, 3);
  assert.equal(plans.codex.pro, 20);
  const summary = summarizeQuota(rows, 123, { planCapacities: plans })!;
  assert.equal(summary.totalUnits, 120);
  assert.equal(summary.remainingUnits, 84);
  const override = summarizeQuota(rows, 123, { planCapacities: plans, accountMultipliers: { b: 10 } })!;
  assert.equal(override.totalUnits, 200);
  assert.equal(override.remainingUnits, 100);
});

test('invalid plan registries are rejected and registry edits do not mutate defaults', () => {
  for (const value of [null, [], { other: {} }, { codex: [] }, { codex: { pro: 0 } }, { codex: { pro: Infinity } }, { claude: { max: '5' } }]) {
    assert.throws(() => parsePlanCapacities(value), /Plan capacities/);
  }
  const changed = parsePlanCapacities({ codex: { prolite: 8 } });
  assert.equal(changed.codex.prolite, 8);
  assert.equal(parsePlanCapacities().codex.prolite, 5);
});

test('Claude weekly scoped Fable usage is included without changing the overall five-hour summary', () => {
  const windows = parseQuota('claude', { five_hour: { utilization: 2 }, seven_day: { utilization: 4 },
    iguana_necktie: null, limits: [{ kind: 'weekly_scoped', scope: { model: { display_name: 'Fable' } },
      percent: 6, is_active: true, resets_at: '2026-09-29T11:00:00Z' }] });
  assert.deepEqual(windows.find(w => w.label === 'Fable week'), {
    label: 'Fable week', kind: 'fable', seconds: 604800, used: 6, overall: false,
    resetAt: Date.parse('2026-09-29T11:00:00Z'),
  });
  assert.equal(summarizeQuota([{ account: { ...account, provider: 'claude' }, windows }], 123)?.remainingUnits, 98);
});

test('active scoped Fable wins over inactive and legacy entries without duplicate windows', () => {
  const windows = parseQuota('claude', { five_hour: { utilization: 2 }, iguana_necktie: { utilization: 30 },
    limits: [
      { kind: 'weekly_scoped', scope: { model: { display_name: 'Fable' } }, percent: 50, is_active: false },
      { kind: 'weekly_scoped', scope: { model: { display_name: 'Fable 5' } }, percent: 6, is_active: true },
      { kind: 'weekly_scoped', scope: { model: { display_name: 'Other' } }, percent: 90, is_active: true },
    ] });
  assert.deepEqual(windows.filter(w => w.label === 'Fable week').map(w => w.used), [6]);
  const legacy = parseQuota('claude', { five_hour: { utilization: 2 }, iguana_necktie: { utilization: 9 } });
  assert.equal(legacy.find(w => w.label === 'Fable week')?.used, 9);
});
test('Fable totals use account capacities and stay unknown if any account has no Fable reading', () => {
  const rows = [20, 80].map((used, i) => ({ account: { ...account, name: `${i}.json`, provider: 'claude' as const },
    windows: parseQuota('claude', { five_hour: { utilization: 2 }, limits: [
      { kind: 'weekly_scoped', scope: { model: { display_name: 'Fable' } }, percent: used, is_active: true },
    ] }) }));
  const summary = summarizeFableQuota(rows, 123, { accountMultipliers: { '0.json': 5, '1.json': 1 } })!;
  assert.equal(summary.remainingUnits, 84);
  assert.equal(summary.totalUnits, 120);
  assert.equal(remainingPercent(summary.used), 70);
  rows[1]!.windows = rows[1]!.windows.filter(w => w.kind !== 'fable');
  assert.equal(summarizeFableQuota(rows, 123), undefined);
  assert.equal(summarizeFableQuota([], 123), undefined);
});

test('5x, 5x, and 1x plans provide 220 normalized units and sum remaining capacity with those weights', () => {
  const accounts = parseAccounts({ files: [
    { name: 'a', type: 'codex', auth_index: 'a', id_token: { plan_type: 'prolite' } },
    { name: 'b', type: 'codex', auth_index: 'b', id_token: { plan_type: 'prolite' } },
    { name: 'c', type: 'codex', auth_index: 'c', id_token: { plan_type: 'team' } },
  ] });
  const rows = accounts.map((account, i) => ({ account, windows: parseQuota('codex', codex([78, 27, 100][i])) }));
  const summary = summarizeQuota(rows, 123)!;
  assert.equal(summary.totalUnits, 220);
  assert.equal(summary.remainingUnits, 95);
  assert.equal(remainingPercent(summary.used), 43);
  rows[2]!.windows = parseQuota('codex', codex(50));
  assert.equal(summarizeQuota(rows, 123)?.remainingUnits, 105);
  const full = rows.map(row => ({ ...row, windows: parseQuota('codex', codex(0)) }));
  assert.equal(summarizeQuota(full, 123)?.remainingUnits, 220);
});

test('account capacity overrides support unknown plans and invalid weights fail closed', () => {
  const rows = ['unknown-a', 'unknown-b'].map((planType, i) => ({ account: { ...account, name: `${i}.json`, planType },
    windows: parseQuota('codex', codex(50)) }));
  assert.throws(() => summarizeQuota(rows, 123), /accountMultipliers/);
  assert.throws(() => summarizeQuota(rows.map(row => ({ ...row, account: { ...row.account, planType: undefined } })), 123), /accountMultipliers/);
  const summary = summarizeQuota(rows, 123, { accountMultipliers: parseAccountMultipliers({ '0.json': 5, '1.json': 1 }) })!;
  assert.equal(summary.totalUnits, 120);
  assert.equal(summary.remainingUnits, 60);
  for (const bad of [null, [], { a: 0 }, { a: -1 }, { a: '5' }, { a: Infinity }]) {
    assert.throws(() => parseAccountMultipliers(bad), /multipliers/);
  }
});

test('capacity colors use remaining units while the displayed percentage uses total capacity', () => {
  const now = Date.now();
  const summary = { used: 100 - 95 / 220 * 100, remainingUnits: 95, totalUnits: 220, seconds: 604800, updatedAt: now };
  assert.equal(statusText([{ provider: 'codex', accounts: [], summary }], now), '⚪ C: -/-  🟢 X: 43%');
  assert.deepEqual([220, 95, 51, 50, 21, 20, 0].map(n => remainingColor(n)), ['green', 'green', 'green', 'orange', 'orange', 'red', 'red']);
});
const codex = (used: unknown, seconds: unknown = 604800) => ({ rate_limit: {
  primary_window: { used_percent: used, limit_window_seconds: seconds, reset_at: 1800000000 },
  secondary_window: null,
} });

test('quota display converts provider and account windows to remaining, including exhaustion and fractional averages', () => {
  const claude = parseQuota('claude', { five_hour: { utilization: 2 }, seven_day: { utilization: 4 } });
  assert.deepEqual(claude.map(w => remainingPercent(w.used)), [98, 96]);
  const codexAccounts = [71, 28, 100].map(used => ({ account, windows: parseQuota('codex', codex(used)) }));
  assert.deepEqual(codexAccounts.map(a => remainingPercent(a.windows[0]!.used)), [29, 72, 0]);
  assert.equal(remainingPercent(summarizeQuota(codexAccounts, 123)!.used), 34);
  const fractional = [0.4, 0.8].map(used => ({ account, windows: parseQuota('codex', codex(used)) }));
  assert.equal(remainingPercent(summarizeQuota(fractional, 123)!.used), 99);
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
  assert.deepEqual(summarizeQuota([{ account: { ...account, provider: 'claude' }, windows }], 123), {
    used: 2, seconds: 18000, updatedAt: 123, remainingUnits: 98, totalUnits: 100,
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
  assert.deepEqual(summarizeQuota([{ account, windows }], 123), { used: 20, seconds: 18000, updatedAt: 123, remainingUnits: 80, totalUnits: 100 });
});

test('accounts at 20 and 80 percent used average to 50 percent, without including model-specific quotas', () => {
  const rows = [20, 80].map(used => ({ account, windows: parseQuota('codex', {
    ...codex(used), code_review_rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 18000 } },
    additional_rate_limits: [{ limit_name: 'Spark', rate_limit: {
      primary_window: { used_percent: 1, limit_window_seconds: 604800 },
    } }],
  }) }));
  assert.deepEqual(summarizeQuota(rows, 123), { used: 50, seconds: 604800, updatedAt: 123, remainingUnits: 100, totalUnits: 200 });
  assert.equal(rows[0]?.windows.length, 3);
  assert.equal(summarizeQuota([], 123), undefined);
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
  assert.throws(() => summarizeQuota(rows, 123), /different shortest/);
  assert.throws(() => summarizeQuota([{ account, windows: [] }], 123), /no overall/);
  assert.throws(() => summarizeQuota([{ ...rows[0]!, error: 'Failed' }], 123), /could not be refreshed/);
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
