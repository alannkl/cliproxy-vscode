import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { CLIProxyClient, normalizeBaseUrl } from './client';
import { QuotaMonitor, refreshIntervalFromMinutes } from './monitor';
import { providerNames, providers, remainingPercent, parseAccountMultipliers, parsePlanCapacities, record } from './quota';
import { isStale, quotaPreview, quotaView, statusText } from './presentation';
import { SharedQuotaCache } from './shared-cache';

const secretId = (url: string) => `managementKey:${url}`;

export function activate(context: vscode.ExtensionContext): void {
  const status = vscode.window.createStatusBarItem('cliproxyUsage.quotas', vscode.StatusBarAlignment.Right, 100);
  let view: vscode.WebviewView | undefined;
  let monitor: QuotaMonitor | undefined;
  let revision = 0;
  let connectionMessage = 'Configure a connection to see your accounts.';
  const readRefreshInterval = () => refreshIntervalFromMinutes(
    vscode.workspace.getConfiguration('cliproxyUsage').get<unknown>('refreshIntervalMinutes'));
  let refreshIntervalMs = readRefreshInterval();
  const readCapacityPolicy = () => {
    const config = vscode.workspace.getConfiguration('cliproxyUsage');
    return { accountMultipliers: parseAccountMultipliers(config.get<unknown>('accountMultipliers')),
      planCapacities: parsePlanCapacities(config.get<unknown>('planCapacities')) };
  };

  status.name = 'CLIProxy Quotas';
  status.command = 'cliproxyUsage.open';
  status.show();
  context.subscriptions.push(status);

  const renderSidebar = () => {
    if (!view) return;
    view.webview.html = quotaView(monitor?.state ?? [], {
      nonce: randomBytes(16).toString('hex'),
      message: connectionMessage,
      refreshing: monitor?.refreshing ?? false,
      checkedAt: monitor?.lastCheckedAt,
      refreshIntervalMs,
    });
  };

  const render = () => {
    renderSidebar();
    const state = monitor?.state ?? [];
    const now = Date.now();
    status.text = statusText(state, now, refreshIntervalMs);
    status.color = state.every(p => !p.summary || isStale(p, now, refreshIntervalMs)) ? new vscode.ThemeColor('disabledForeground') : undefined;
    if (state.length) {
      const preview = new vscode.MarkdownString(quotaPreview(state, monitor?.lastCheckedAt, now, refreshIntervalMs));
      preview.supportHtml = true;
      preview.isTrusted = { enabledCommands: ['cliproxyUsage.open'] };
      status.tooltip = preview;
    } else {
      status.tooltip = `${connectionMessage}\nRun CLIProxy Usage: Configure Connection.`;
    }
    status.accessibilityInformation = { label: providers.map(provider => {
      const quota = state.find(p => p.provider === provider);
      const fable = provider === 'claude' ? `; Fable weekly: ${quota?.fableSummary ? remainingPercent(quota.fableSummary.used) + '% remaining' : 'unavailable'}` : '';
      return `${providerNames[provider]}: ${quota?.summary ? remainingPercent(quota.summary.used) + '% remaining, ' + Math.round(quota.summary.remainingUnits) + ' of ' + Math.round(quota.summary.totalUnits) + ' units' : 'unavailable'}${fable}${!quota?.summary || isStale(quota, now, refreshIntervalMs) ? ', stale or unconfigured' : ''}`;
    }).join('; ') };
  };

  const reload = async () => {
    const current = ++revision;
    monitor?.dispose();
    monitor = undefined;
    connectionMessage = 'Configure a connection to see your accounts.';
    render();
    const configuredUrl = vscode.workspace.getConfiguration('cliproxyUsage').get<string>('baseUrl', '');
    if (!configuredUrl.trim()) return;
    try {
      const url = normalizeBaseUrl(configuredUrl);
      const key = await context.secrets.get(secretId(url));
      if (current !== revision) return;
      if (!key) {
        connectionMessage = 'Management key missing. Run Configure Connection.';
        render();
        return;
      }
      const client = new CLIProxyClient(url, key);
      monitor = new QuotaMonitor(client, render, refreshIntervalMs, {
        sharedCache: new SharedQuotaCache(join(context.globalStorageUri.fsPath, 'quota-cache'), client.cacheKey),
        capacityPolicy: readCapacityPolicy(),
      });
      monitor.start();
    } catch {
      if (current !== revision) return;
      connectionMessage = 'Unable to load connection or capacity settings. Check CLIProxy Usage settings.';
      render();
    }
  };

  const configure = async () => {
    const input = await vscode.window.showInputBox({ title: 'CLIProxy server URL',
      prompt: 'The server reachable from this computer over Tailscale.',
      placeHolder: 'http://your-vm:8317',
      value: vscode.workspace.getConfiguration('cliproxyUsage').get<string>('baseUrl', ''),
      ignoreFocusOut: true,
      validateInput: value => { try { normalizeBaseUrl(value); return undefined; } catch (error) { return (error as Error).message; } },
    });
    if (input === undefined) return;
    const url = normalizeBaseUrl(input);
    const key = await vscode.window.showInputBox({ title: 'CLIProxy management key', password: true,
      prompt: 'Stored securely in VS Code for this server URL.', ignoreFocusOut: true,
      validateInput: value => value.trim() ? undefined : 'Enter the management key.' });
    if (key === undefined) return;
    try {
      await context.secrets.store(secretId(url), key.trim());
      await vscode.workspace.getConfiguration('cliproxyUsage').update('baseUrl', url, vscode.ConfigurationTarget.Global);
      await reload();
    } catch {
      void vscode.window.showErrorMessage('Unable to save the CLIProxy connection settings.');
    }
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('cliproxyUsage.accounts', {
      resolveWebviewView(resolved) {
        view = resolved;
        resolved.webview.options = {
          enableScripts: false,
          enableCommandUris: ['cliproxyUsage.configure', 'cliproxyUsage.refreshTarget'],
          localResourceRoots: [],
        };
        resolved.onDidDispose(() => { if (view === resolved) view = undefined; }, undefined, context.subscriptions);
        renderSidebar();
      },
    }),
    vscode.commands.registerCommand('cliproxyUsage.configure', configure),
    vscode.commands.registerCommand('cliproxyUsage.open', () => vscode.commands.executeCommand('cliproxyUsage.accounts.focus')),
    vscode.commands.registerCommand('cliproxyUsage.refresh', async () => {
      if (!monitor) return configure();
      await monitor.refresh('manual');
    }),
    vscode.commands.registerCommand('cliproxyUsage.refreshTarget', async (value: unknown) => {
      const target = record(value);
      if (!target || (target.provider !== 'claude' && target.provider !== 'codex')
        || (target.accountId !== undefined && typeof target.accountId !== 'string')) return;
      if (!monitor) return configure();
      await monitor.refresh('manual', { provider: target.provider, accountId: target.accountId });
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('cliproxyUsage.accountMultipliers') || event.affectsConfiguration('cliproxyUsage.planCapacities')) {
        try {
          const policy = readCapacityPolicy();
          if (monitor) monitor.setCapacityPolicy(policy);
          else void reload();
        } catch {
          void vscode.window.showErrorMessage('Check CLIProxy planCapacities and accountMultipliers. Capacities must be numbers greater than 0 and at most 1000.');
        }
      }
      if (event.affectsConfiguration('cliproxyUsage.refreshIntervalMinutes')) {
        refreshIntervalMs = readRefreshInterval();
        monitor?.setRefreshInterval(refreshIntervalMs);
        render();
      }
      if (event.affectsConfiguration('cliproxyUsage.baseUrl')) void reload();
    }),
    context.secrets.onDidChange(event => {
      if (event.key.startsWith('managementKey:')) void reload();
    }),
    vscode.window.onDidChangeWindowState(event => {
      if (event.focused && monitor && Date.now() - (monitor.lastAttempt ?? 0) >= monitor.refreshIntervalMs) void monitor.refresh();
    }),
    { dispose: () => { revision++; monitor?.dispose(); } },
  );
  void reload();
}
