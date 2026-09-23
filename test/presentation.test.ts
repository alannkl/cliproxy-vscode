import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderQuota } from '../src/monitor';
import { quotaPreview, quotaView, resetIn, statusText } from '../src/presentation';

const now = Date.parse('2026-09-23T08:00:00Z');
const options = { nonce: 'test-nonce', message: 'Configure a connection.', refreshing: false, checkedAt: now, now };

test('readings stay fresh for the configured interval instead of turning stale after two minutes', () => {
  assert.equal(statusText([claude], now + 180000), '🟢 C: 98%  ⚪ X: -');
  assert.equal(statusText([claude], now + 600001), '⚪ C: 98%  ⚪ X: -');
  const later = now + 900000;
  assert.equal(statusText([claude], later, 600000), '🟢 C: 98%  ⚪ X: -');
  assert.doesNotMatch(quotaPreview([claude], now, later, 600000), /Stale \/ unavailable/);
  assert.doesNotMatch(quotaView([claude], { ...options, now: later, refreshIntervalMs: 600000 }), /Stale \/ unavailable/);
  assert.match(quotaPreview([claude], now, later, 300000), /Stale \/ unavailable/);
  assert.match(quotaView([claude], { ...options, now: later, refreshIntervalMs: 300000 }), /Stale \/ unavailable/);
  assert.equal(statusText([{ ...claude, error: 'Failed' }], now, 600000), '⚪ C: 98%  ⚪ X: -');
});

test('hover contains an Open full view link so it remains interactive when the pointer enters', () => {
  const preview = quotaPreview([claude, codex], now, now);
  assert.ok(preview.startsWith('[Open full view](command:cliproxyUsage.open)\n'));
  assert.equal((preview.match(/\]\(command:/g) ?? []).length, 1);
});

test('hover bars use quota colors and stale bars stay gray', () => {
  const orange: ProviderQuota = { ...codex, accounts: codex.accounts.map(a => ({ ...a,
    windows: a.windows.map(w => ({ ...w, used: 66 })) })) };
  assert.match(quotaPreview([claude], now, now), /<span style="color:var\(--vscode-charts-green\);">▰/);
  assert.match(quotaPreview([orange], now, now), /<span style="color:var\(--vscode-charts-orange\);">▰/);
  assert.match(quotaPreview([codex], now, now), /<span style="color:var\(--vscode-charts-red\);">▰/);
  const stale = quotaPreview([{ ...claude, error: 'Unavailable' }], now, now);
  assert.match(stale, /<span style="color:var\(--vscode-disabledForeground\);">▰/);
  assert.doesNotMatch(stale, /--vscode-charts-green/);
});

test('one combined status and hover keep both providers together with one shared timestamp', () => {
  assert.equal(statusText([claude, codex], now), '🟢 C: 98%  🔴 X: 20%');
  const preview = quotaPreview([claude, codex], now, now);
  assert.match(preview, /### Claude quota remaining/);
  assert.match(preview, /### Codex quota remaining/);
  assert.equal((preview.match(/Last checked/g) ?? []).length, 1);
});
const claude: ProviderQuota = {
  provider: 'claude', summary: { used: 2, seconds: 18000, updatedAt: now },
  accounts: [{
    account: { id: 'c', name: 'claude-1234abcd-example@example.com.json', provider: 'claude', disabled: false },
    updatedAt: now,
    windows: [
      { label: '5h', used: 2, seconds: 18000, overall: true, resetAt: now + 7980000 },
      { label: 'week', used: 4, seconds: 604800, overall: true, resetAt: now + 180000000 },
    ],
  }],
};
const codex: ProviderQuota = {
  provider: 'codex', summary: { used: 80, seconds: 604800, updatedAt: now },
  accounts: [{ account: { id: 'x', name: 'team.json', provider: 'codex', disabled: true }, updatedAt: now,
    windows: [{ label: 'week', used: 80, seconds: 604800, overall: true }] }],
};

test('full sidebar shows each provider, account, remaining bar, and reset time without disclosure controls', () => {
  const page = quotaView([claude, codex], options);
  assert.match(page, /<h2>Claude<\/h2>/);
  assert.match(page, /<h2>Codex<\/h2>/);
  assert.match(page, />example@example.com<\/h3>/);
  assert.match(page, />team<span class="badge">disabled/);
  assert.equal((page.match(/<progress /g) ?? []).length, 3);
  assert.match(page, /value="98"/);
  assert.match(page, /value="96"/);
  assert.match(page, /value="20"/);
  assert.match(page, /Reset: 2h 13m/);
  assert.match(page, /Reset: 2d 2h/);
  assert.match(page, /Reset: Not reported/);
  assert.equal((page.match(/Last checked/g) ?? []).length, 1);
  assert.doesNotMatch(page, /<details|<summary|aria-expanded|Updated /);
});

test('unconfigured sidebar offers Configure Connection and stale quota stays visibly stale', () => {
  assert.match(quotaView([], options), /href="command:cliproxyUsage.configure">Configure Connection<\/a>/);
  const stale: ProviderQuota = { ...claude, error: 'Some accounts could not be refreshed.',
    accounts: claude.accounts.map(a => ({ ...a, error: 'Provider quota API returned HTTP 429.' })) };
  const page = quotaView([stale], options);
  assert.match(page, /Stale \/ unavailable: Some accounts could not be refreshed/);
  assert.match(page, /Stale \/ unavailable: Provider quota API returned HTTP 429/);
  assert.match(page, /class="gray" max="100" value="98"/);
  assert.equal((page.match(/Last checked/g) ?? []).length, 1);
});

test('account labels and errors cannot inject HTML or executable links into the sidebar or hover', () => {
  const malicious = '<script>alert(1)</script>[click](command:workbench.action.closeWindow)';
  const quota: ProviderQuota = { ...claude, error: malicious, accounts: [{ ...claude.accounts[0]!,
    account: { ...claude.accounts[0]!.account, name: malicious }, error: malicious }] };
  const page = quotaView([quota], options);
  assert.doesNotMatch(page, /<script>|href="command:workbench/);
  assert.match(page, /&lt;script&gt;/);
  assert.match(page, /default-src 'none'; style-src 'nonce-test-nonce'/);
  const preview = quotaPreview([quota], now, now);
  assert.ok(preview.includes('\\<script\\>'));
  assert.ok(preview.includes('\\[click\\]\\(command:workbench\\.action\\.closeWindow\\)'));
  assert.ok(!preview.includes('[click](command:'));
});

test('hover preview shows all account windows with remaining bars and reset countdowns', () => {
  const preview = quotaPreview([claude], now, now);
  assert.match(preview, /98%\*\* average/);
  assert.match(preview, /5 hour \| <span[^>]+>▰{10}<\/span> \*\*98%\*\* \| 2h 13m/);
  assert.match(preview, /Weekly \| <span[^>]+>▰{10}<\/span> \*\*96%\*\* \| 2d 2h/);
  assert.equal((preview.match(/Last checked/g) ?? []).length, 1);
  assert.equal(resetIn(now, now), 'Awaiting reset');
  assert.equal(resetIn(now + 60_000, now), '1m');
  assert.equal(resetIn(undefined, now), 'Not reported');
});

test('status uses one compact string with a large colored circle and a short dash when unavailable', () => {
  assert.equal(statusText([claude], now), '🟢 C: 98%  ⚪ X: -');
  assert.equal(statusText([codex], now), '⚪ C: -  🔴 X: 20%');
  assert.equal(statusText([{ ...codex, summary: { used: 66, seconds: 604800, updatedAt: now } }], now), '⚪ C: -  🟠 X: 34%');
  assert.equal(statusText([], now), '⚪ C: -  ⚪ X: -');
  assert.equal(statusText([{ ...claude, error: 'Failed' }, codex], now), '⚪ C: 98%  🔴 X: 20%');
});
