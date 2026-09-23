import { CLIProxyClient, RefreshMode } from './client';
import { AccountQuota, averageQuota, Provider, providers, Summary } from './quota';

export const DEFAULT_REFRESH_MS = 5 * 60_000;

export function refreshIntervalFromMinutes(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 1440
    ? value * 60_000 : DEFAULT_REFRESH_MS;
}

export interface ProviderQuota {
  provider: Provider;
  accounts: AccountQuota[];
  summary?: Summary;
  error?: string;
}

export class QuotaMonitor {
  state: ProviderQuota[] = providers.map(provider => ({ provider, accounts: [] }));
  refreshing = false;
  lastAttempt?: number;
  lastCheckedAt?: number;
  private pending?: Promise<void>;
  private pendingMode?: RefreshMode;
  private queuedManual?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private readonly controller = new AbortController();

  constructor(private readonly client: CLIProxyClient, private readonly onChange: () => void,
    private intervalMs = DEFAULT_REFRESH_MS) {}

  get refreshIntervalMs(): number { return this.intervalMs; }

  setRefreshInterval(intervalMs: number): void {
    if (this.controller.signal.aborted || intervalMs === this.intervalMs) return;
    this.intervalMs = intervalMs;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = setInterval(() => { void this.refresh(); }, this.intervalMs);
    }
  }

  start(): void {
    if (this.timer || this.controller.signal.aborted) return;
    this.timer = setInterval(() => { void this.refresh(); }, this.intervalMs);
    void this.refresh();
  }

  refresh(mode: RefreshMode = 'automatic'): Promise<void> {
    if (this.controller.signal.aborted) return Promise.resolve();
    if (this.pending) {
      if (mode === 'manual' && this.pendingMode === 'automatic') {
        this.queuedManual ??= this.pending.then(() => {
          this.queuedManual = undefined;
          return this.refresh('manual');
        });
        return this.queuedManual;
      }
      return this.pending;
    }
    this.refreshing = true;
    this.lastAttempt = Date.now();
    this.pendingMode = mode;
    this.pending = this.run(mode).finally(() => {
      this.pending = undefined;
      this.pendingMode = undefined;
      this.refreshing = false;
      if (!this.controller.signal.aborted) {
        this.lastCheckedAt = Date.now();
        this.onChange();
      }
    });
    this.onChange();
    return this.pending;
  }

  private async run(mode: RefreshMode): Promise<void> {
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(50_000)]);
    try {
      const accounts = await this.client.accounts(signal);
      const previous = new Map(this.state.flatMap(p => p.accounts.map(a => [a.account.id, a] as const)));
      const results: AccountQuota[] = [];
      let next = 0;
      // A small bounded pool avoids one simultaneous upstream request per auth file.
      const worker = async () => {
        while (next < accounts.length) {
          const account = accounts[next++]!;
          try {
            if (signal.aborted) throw new Error('Refresh timed out or was cancelled.');
            const windows = await this.client.quota(account, signal, mode);
            results.push({ account, windows, updatedAt: Date.now() });
          } catch (error) {
            const old = previous.get(account.id);
            results.push({ account, windows: old?.windows ?? [], updatedAt: old?.updatedAt,
              error: error instanceof Error ? error.message : 'Quota request failed.' });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, accounts.length) }, worker));
      if (this.controller.signal.aborted) return;
      this.state = providers.map(provider => {
        const current = results.filter(a => a.account.provider === provider)
          .sort((a, b) => a.account.name.localeCompare(b.account.name));
        try {
          return { provider, accounts: current, summary: averageQuota(current, Date.now()) };
        } catch (error) {
          const old = this.state.find(p => p.provider === provider);
          // A cached average is only meaningful for the same set of accounts.
          const sameAccounts = old?.accounts.length === current.length
            && current.every(a => old.accounts.some(b => a.account.id === b.account.id));
          return { provider, accounts: current, summary: sameAccounts ? old?.summary : undefined,
            error: error instanceof Error ? error.message : 'Quota average unavailable.' };
        }
      });
    } catch (error) {
      if (this.controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : 'Unable to refresh accounts.';
      this.state = this.state.map(p => ({ ...p, error: message,
        accounts: p.accounts.map(a => ({ ...a, error: message })) }));
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.controller.abort();
  }
}
