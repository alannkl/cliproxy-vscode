import { ProviderQuota, DEFAULT_REFRESH_MS } from './monitor';
import { RefreshTarget } from './client';
import { Account, AccountQuota, providerNames, providers, quotaColor, remainingColor, remainingPercent, windowLabel } from './quota';

const circles = { green: '🟢', orange: '🟠', red: '🔴', gray: '⚪' } as const;

export function isStale(quota: ProviderQuota, now = Date.now(), refreshIntervalMs = DEFAULT_REFRESH_MS): boolean {
  return Boolean(quota.error) || (quota.summary !== undefined && now - quota.summary.updatedAt > refreshIntervalMs * 2);
}

function providerStatus(quota: ProviderQuota, now: number, refreshIntervalMs: number): string {
  if (quota.provider === 'claude') {
    const fiveHour = quota.summary?.seconds === 18000 ? quota.summary : undefined;
    const fable = quota.fableSummary;
    const units = fiveHour && fable ? Math.min(fiveHour.remainingUnits, fable.remainingUnits) : undefined;
    const color = remainingColor(units, isStale(quota, now, refreshIntervalMs));
    return `${circles[color]} C: ${fiveHour ? remainingPercent(fiveHour.used) + '%' : '-'}/${fable ? remainingPercent(fable.used) + '%' : '-'}`;
  }
  const color = remainingColor(quota.summary?.remainingUnits, isStale(quota, now, refreshIntervalMs));
  const value = quota.summary ? `${remainingPercent(quota.summary.used)}%` : '-';
  return `${circles[color]} X: ${value}`;
}

export function statusText(state: ProviderQuota[], now = Date.now(), refreshIntervalMs = DEFAULT_REFRESH_MS): string {
  return providers.map(provider => providerStatus(state.find(p => p.provider === provider)
    ?? { provider, accounts: [] }, now, refreshIntervalMs)).join('  ');
}

function accountName(account: Account): string {
  return account.name.replace(/\.json$/i, '').replace(/^(claude|codex)-[a-f0-9]{8,}-/i, '');
}

function planName(account: Account): string | undefined {
  return account.planType?.replace(/^default_claude_/, '').replaceAll('_', ' ');
}

function windowName(label: string): string {
  return label === 'week' ? 'Weekly' : label === '5h' ? '5 hour' : label;
}

export function resetIn(resetAt: number | undefined, now: number): string {
  if (resetAt === undefined) return 'Not reported';
  const minutes = Math.ceil((resetAt - now) / 60_000);
  if (minutes <= 0) return 'Awaiting reset';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function html(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function markdown(value: string): string {
  return value.replace(/[\r\n]/g, ' ').replace(/[\\`*_{}\[\]()<>#+.!|~-]/g, '\\$&');
}

function checkedTime(checkedAt: number | undefined): string {
  return checkedAt === undefined ? 'Waiting for first refresh' : `Last checked ${new Date(checkedAt).toLocaleTimeString()}`;
}

function accountWarning(entry: AccountQuota, quota: ProviderQuota, now: number, refreshIntervalMs: number): string | undefined {
  if (entry.error) return entry.error;
  if (entry.updatedAt !== undefined && now - entry.updatedAt > refreshIntervalMs * 2) return 'Waiting for a fresh reading.';
  // Provider-wide failures without account errors, such as mismatched windows, still need an explanation.
  if (quota.error && !quota.accounts.some(account => account.error)) return quota.error;
  return undefined;
}

function providerPreview(quota: ProviderQuota, now: number, refreshIntervalMs: number): string {
  const lines = [`### ${providerNames[quota.provider]} quota remaining`, ''];
  if (quota.summary) lines.push(`**${remainingPercent(quota.summary.used)}%** remaining · **${Math.round(quota.summary.remainingUnits)} / ${Math.round(quota.summary.totalUnits)} units** · ${windowLabel(quota.summary.seconds)}`, '');
  if (quota.fableSummary) lines.push(`Fable weekly: **${remainingPercent(quota.fableSummary.used)}%** · **${Math.round(quota.fableSummary.remainingUnits)} / ${Math.round(quota.fableSummary.totalUnits)} units**`, '');
  if (!quota.accounts.length) lines.push(markdown(quota.error ?? 'No accounts found.'), '');
  for (const entry of quota.accounts) {
    const warning = accountWarning(entry, quota, now, refreshIntervalMs);
    lines.push(`**${markdown(accountName(entry.account))}**${entry.account.planType ? ' · ' + markdown(planName(entry.account)!) : ''}${entry.account.disabled ? ' · disabled' : ''}`, '');
    if (warning) lines.push(`Stale / unavailable: ${markdown(warning)}`, '');
    lines.push('<table><tbody>');
    for (const window of entry.windows) {
      const remaining = remainingPercent(window.used);
      const filled = Math.round(remaining / 10);
      const bar = '▰'.repeat(filled) + '▱'.repeat(10 - filled);
      const color = quotaColor(window.used, Boolean(warning));
      const themeColor = color === 'gray' ? '--vscode-disabledForeground' : `--vscode-charts-${color}`;
      lines.push(`<tr><td>${html(windowName(window.label))}</td><td><span style="color:var(${themeColor});">${bar}</span> <strong>${remaining}%</strong></td><td>${resetIn(window.resetAt, now)}</td></tr>`);
    }
    if (!entry.windows.length) lines.push('<tr><td>Quota unavailable</td></tr>');
    lines.push('</tbody></table>', '');
  }
  return lines.join('\n');
}

export function quotaPreview(state: ProviderQuota[], checkedAt?: number, now = Date.now(), refreshIntervalMs = DEFAULT_REFRESH_MS): string {
  // VS Code keeps Markdown hovers interactive when they contain a link.
  return ['[Open full view](command:cliproxyUsage.open)', '',
    ...state.map(quota => providerPreview(quota, now, refreshIntervalMs)), '---', checkedTime(checkedAt)].join('\n');
}

interface ViewOptions {
  nonce: string;
  message: string;
  refreshing: boolean;
  checkedAt?: number;
  now?: number;
  refreshIntervalMs?: number;
}

function refreshLink(target: RefreshTarget, label: string): string {
  const args = encodeURIComponent(JSON.stringify([target]));
  return `<a class="refresh" href="command:cliproxyUsage.refreshTarget?${html(args)}" title="${html(label)}" aria-label="${html(label)}">Refresh</a>`;
}

export function quotaView(state: ProviderQuota[], options: ViewOptions): string {
  const now = options.now ?? Date.now();
  const sections = state.map(quota => {
    const summary = quota.summary ? `${remainingPercent(quota.summary.used)}% · ${Math.round(quota.summary.remainingUnits)}/${Math.round(quota.summary.totalUnits)} units · ${windowLabel(quota.summary.seconds)}` : '-';
    const accounts = quota.accounts.map(entry => {
      const warning = accountWarning(entry, quota, now, options.refreshIntervalMs ?? DEFAULT_REFRESH_MS);
      const windows = entry.windows.map(window => {
        const remaining = remainingPercent(window.used);
        const color = quotaColor(window.used, Boolean(warning));
        const reset = window.resetAt ? new Date(window.resetAt).toLocaleString() : 'Reset time not reported';
        return `<div class="window">
          <span class="window-name">${html(windowName(window.label))}</span>
          <progress class="${color}" max="100" value="${remaining}" aria-label="${html(window.label)} quota remaining">${remaining}%</progress>
          <span class="percent">${remaining}%</span>
          <span class="reset" title="${html(reset)}">Reset: ${resetIn(window.resetAt, now)}</span>
        </div>`;
      }).join('');
      return `<article class="account">
        <div class="account-heading"><h3 title="${html(entry.account.name)}">${html(accountName(entry.account))}${entry.account.planType ? `<span class="badge" title="${html(entry.account.planType)}">${html(planName(entry.account)!)}</span>` : ''}${entry.account.disabled ? '<span class="badge">disabled</span>' : ''}</h3>
        ${refreshLink({ provider: quota.provider, accountId: entry.account.id }, `Refresh ${entry.account.name}`)}</div>
        ${warning ? `<p class="warning">Stale / unavailable: ${html(warning)}</p>` : ''}
        ${windows || '<p class="muted">Quota unavailable</p>'}
      </article>`;
    }).join('');
    return `<section class="provider"><header><h2>${providerNames[quota.provider]}</h2><span class="summary">${summary}</span>
      ${refreshLink({ provider: quota.provider }, `Refresh all ${providerNames[quota.provider]} accounts`)}</header>
      ${accounts || `<p class="${quota.error ? 'warning' : 'muted'}">${html(quota.error ?? 'No accounts found.')}</p>`}</section>`;
  }).join('');
  const content = state.length ? sections : `<div class="setup"><p>${html(options.message)}</p>
    <a class="button" href="command:cliproxyUsage.configure">Configure Connection</a></div>`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${options.nonce}';">
<style nonce="${options.nonce}">
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 14px 16px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font: var(--vscode-font-size, 13px) var(--vscode-font-family, sans-serif); }
  .provider + .provider { border-top: 1px solid var(--vscode-widget-border, #8884); margin-top: 24px; padding-top: 18px; }
  header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px; margin-bottom: 18px; }
  h2, h3, p { margin: 0; }
  h2 { font-size: 14px; font-weight: 600; }
  .summary, .muted, .reset, footer { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .summary { margin-left: auto; }
  .account + .account { margin-top: 22px; }
  .account-heading { display: flex; align-items: baseline; gap: 12px; margin-bottom: 10px; }
  h3 { flex: 1; min-width: 0; font-size: 12px; font-weight: 600; line-height: 1.5; overflow-wrap: anywhere; }
  .refresh { flex-shrink: 0; color: var(--vscode-textLink-foreground); font-size: 11px; text-decoration: none; }
  .refresh:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
  .refresh:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .badge { margin-left: 8px; font-size: 10px; font-weight: normal; color: var(--vscode-descriptionForeground); }
  .window { display: grid; grid-template-columns: minmax(50px, auto) minmax(40px, 1fr) 4ch; align-items: center; gap: 4px 10px; margin: 10px 0; }
  .window-name { font-size: 12px; max-width: 100px; overflow-wrap: anywhere; }
  .percent { text-align: right; font-size: 12px; font-variant-numeric: tabular-nums; }
  progress { appearance: none; border: 0; width: 100%; height: 7px; border-radius: 3px; overflow: hidden; background: var(--vscode-progressBar-background, #8884); }
  progress::-webkit-progress-bar { background: var(--vscode-editorWidget-background, #8883); }
  progress::-webkit-progress-value { background: var(--bar); border-radius: 3px; }
  progress::-moz-progress-bar { background: var(--bar); border-radius: 3px; }
  .green { --bar: var(--vscode-charts-green, #73c991); }
  .orange { --bar: var(--vscode-charts-orange, #d7ba7d); }
  .red { --bar: var(--vscode-charts-red, #f48771); }
  .gray { --bar: var(--vscode-disabledForeground, #888); }
  .reset { grid-column: 2 / 4; }
  .warning { color: var(--vscode-editorWarning-foreground, #d7ba7d); font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; margin: 8px 0; }
  footer { border-top: 1px solid var(--vscode-widget-border, #8884); margin-top: 24px; padding-top: 12px; line-height: 1.6; }
  .setup { line-height: 1.6; }
  .button { display: block; margin-top: 14px; padding: 7px 10px; text-align: center; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 1px solid var(--vscode-button-border, transparent); text-decoration: none; }
  .button:hover { background: var(--vscode-button-hoverBackground); }
  .button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
</style></head><body>${content}
${state.length ? `<footer>${html(checkedTime(options.checkedAt))}${options.refreshing ? ' · Refreshing…' : ''}</footer>` : ''}
</body></html>`;
}
