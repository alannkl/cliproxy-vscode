import { CLIProxyClient, RefreshMode, RefreshTarget, refreshCovers } from './client';
import { CapacityPolicy, AccountQuota, summarizeQuota, summarizeFableQuota, Provider, providers, Summary } from './quota';
import { randomUUID } from 'node:crypto';
import { SharedQuotaCache, QuotaSnapshot } from './shared-cache';

export const DEFAULT_REFRESH_MS = 5 * 60_000;

export function refreshIntervalFromMinutes(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 1440
    ? value * 60_000 : DEFAULT_REFRESH_MS;
}

export interface ProviderQuota {
  provider: Provider;
  accounts: AccountQuota[];
  summary?: Summary;
  fableSummary?: Summary;
  error?: string;
  lastCompleteAccounts?: AccountQuota[];
}

export class QuotaMonitor {
  state: ProviderQuota[] = providers.map(provider => ({ provider, accounts: [] }));
  refreshing = false;
  lastAttempt?: number;
  lastCheckedAt?: number;
  private pending?: Promise<void>;
  private pendingMode?: RefreshMode;
  private pendingTarget?: RefreshTarget;
  private readonly queued = new Map<string, Promise<void>>();
  private lastFullCheckedAt?: number;
  private timer?: ReturnType<typeof setInterval>;
  private readonly controller = new AbortController();
  private unsubscribe?: () => void;
  private revision?: string;
  private capacityPolicy: CapacityPolicy;

  constructor(private readonly client: CLIProxyClient, private readonly onChange: () => void,
    private intervalMs = DEFAULT_REFRESH_MS,
    private readonly options: { sharedCache?: SharedQuotaCache; capacityPolicy?: CapacityPolicy } = {}) {
    this.capacityPolicy = options.capacityPolicy ?? {};
  }

  setCapacityPolicy(policy: CapacityPolicy): void {
    this.capacityPolicy = policy;
    const previous = this.state;
    this.state = this.summarize(this.state.flatMap(p => p.accounts), this.state, this.lastCheckedAt ?? Date.now());
    for (const provider of this.state) {
      if (!provider.accounts.length) provider.error = previous.find(p => p.provider === provider.provider)?.error;
    }
    this.onChange();
  }

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
    this.unsubscribe = this.options.sharedCache?.subscribe(snapshot => {
      if (!this.pending && !this.controller.signal.aborted && snapshot.revision !== this.revision) {
        this.adopt(snapshot);
        this.onChange();
      }
    });
    this.timer = setInterval(() => { void this.refresh(); }, this.intervalMs);
    void this.refresh();
  }

  refresh(mode: RefreshMode = 'automatic', target?: RefreshTarget): Promise<void> {
    if (this.controller.signal.aborted) return Promise.resolve();
    if (this.pending) {
      if ((mode === 'manual' && this.pendingMode === 'automatic') || !refreshCovers(this.pendingTarget, target)) {
        const key = JSON.stringify([mode, target?.provider, target?.accountId]);
        if (!this.queued.has(key)) {
          this.queued.set(key, this.pending.then(() => {
            this.queued.delete(key);
            return this.refresh(mode, target);
          }));
        }
        return this.queued.get(key)!;
      }
      return this.pending;
    }
    this.refreshing = true;
    if (!target) this.lastAttempt = Date.now();
    this.pendingMode = mode;
    this.pendingTarget = target;
    this.pending = this.run(mode, target).finally(() => {
      this.pending = undefined;
      this.pendingMode = undefined;
      this.pendingTarget = undefined;
      this.refreshing = false;
      if (!this.controller.signal.aborted) {
        this.onChange();
      }
    });
    this.onChange();
    return this.pending;
  }

  private async run(mode: RefreshMode, target?: RefreshTarget): Promise<void> {
    try {
      if (this.options.sharedCache) {
        const snapshot = await this.options.sharedCache.refresh(mode, this.intervalMs, this.controller.signal, async (previous, signal) => {
          if (previous) this.adopt(previous);
          if (!target) this.lastAttempt = Date.now();
          await this.fetch(mode, signal, target);
          this.lastCheckedAt = Date.now();
          if (!target) this.lastFullCheckedAt = this.lastCheckedAt;
          return { version: 1, revision: randomUUID(), mode, target,
            lastFullCheckedAt: target ? this.lastFullCheckedAt : undefined, lastAttempt: this.lastAttempt ?? 0,
            lastCheckedAt: this.lastCheckedAt, state: this.state, cooldowns: this.client.exportCooldowns() };
        }, target);
        if (!this.controller.signal.aborted) this.adopt(snapshot);
      } else {
        await this.fetch(mode, this.controller.signal, target);
        this.lastCheckedAt = Date.now();
        if (!target) this.lastFullCheckedAt = this.lastCheckedAt;
      }
    } catch {
      if (!this.controller.signal.aborted) {
        const message = 'Shared quota refresh unavailable. Another window may still be refreshing; retry shortly.';
        this.markError(message, target);
      }
    }
  }

  private adopt(snapshot: QuotaSnapshot): void {
    this.revision = snapshot.revision;
    this.lastAttempt = snapshot.lastAttempt;
    this.lastCheckedAt = snapshot.lastCheckedAt;
    this.lastFullCheckedAt = snapshot.target ? snapshot.lastFullCheckedAt : snapshot.lastCheckedAt;
    this.client.importCooldowns(snapshot.cooldowns);
    this.state = this.summarize(snapshot.state.flatMap(p => p.accounts), snapshot.state, snapshot.lastCheckedAt);
    // Preserve discovery errors when there are no account rows to carry the error.
    for (const provider of this.state) {
      if (!provider.accounts.length) provider.error = snapshot.state.find(p => p.provider === provider.provider)?.error;
    }
  }

  private summarize(results: AccountQuota[], previous: ProviderQuota[], checkedAt: number): ProviderQuota[] {
    return providers.map(provider => {
      const accounts = results.filter(a => a.account.provider === provider)
        .sort((a, b) => a.account.name.localeCompare(b.account.name));
      try {
        const updatedAt = accounts.reduce((oldest, account) => Math.min(oldest, account.updatedAt ?? checkedAt), checkedAt);
        return { provider, accounts, summary: summarizeQuota(accounts, updatedAt, this.capacityPolicy),
          fableSummary: provider === 'claude' ? summarizeFableQuota(accounts, updatedAt, this.capacityPolicy) : undefined,
          lastCompleteAccounts: accounts };
      } catch (error) {
        const old = previous.find(p => p.provider === provider);
        const complete = old?.lastCompleteAccounts;
        const sameAccounts = complete?.length === accounts.length && accounts.every(a =>
          complete.some(b => a.account.id === b.account.id && a.account.planType === b.account.planType));
        let summary: Summary | undefined;
        let fableSummary: Summary | undefined;
        if (sameAccounts) {
          try {
            const updatedAt = old?.summary?.updatedAt ?? checkedAt;
            summary = summarizeQuota(complete, updatedAt, this.capacityPolicy);
            if (provider === 'claude') fableSummary = summarizeFableQuota(complete, updatedAt, this.capacityPolicy);
          } catch { /* No guessed capacity. */ }
        }
        return { provider, accounts, summary, fableSummary, lastCompleteAccounts: sameAccounts ? complete : undefined,
          error: error instanceof Error ? error.message : 'Quota capacity unavailable.' };
      }
    });
  }

  private markError(message: string, target?: RefreshTarget): void {
    this.state = this.state.map(p => target && p.provider !== target.provider ? p : { ...p, error: message,
      accounts: p.accounts.map(a => refreshCovers(target, { provider: p.provider, accountId: a.account.id })
        ? { ...a, error: message } : a) });
  }

  private async fetch(mode: RefreshMode, parentSignal: AbortSignal, target?: RefreshTarget): Promise<void> {
    const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(50_000)]);
    try {
      const accounts = (await this.client.accounts(signal))
        .filter(account => refreshCovers(target, { provider: account.provider, accountId: account.id }));
      const previous = new Map(this.state.flatMap(p => p.accounts.map(a => [a.account.id, a] as const)));
      const results: AccountQuota[] = [...previous.values()].filter(entry =>
        !refreshCovers(target, { provider: entry.account.provider, accountId: entry.account.id }));
      let next = 0;
      // A small bounded pool avoids one simultaneous upstream request per auth file.
      const worker = async () => {
        while (next < accounts.length) {
          const account = accounts[next++]!;
          try {
            if (signal.aborted) throw new Error('Refresh timed out or was cancelled.');
            const reading = await this.client.quota(account, signal, mode);
            // The live quota plan can change before the stored OAuth metadata does.
            const currentAccount = { ...account, planType: reading.planType ?? account.planType };
            results.push({ account: currentAccount, windows: reading.windows, updatedAt: Date.now() });
          } catch (error) {
            const old = previous.get(account.id);
            // Keep the cached plan paired with the cached quota if auth-file metadata lags behind it.
            const cachedAccount = { ...account, planType: old?.account.planType ?? account.planType };
            results.push({ account: cachedAccount, windows: old?.windows ?? [], updatedAt: old?.updatedAt,
              error: error instanceof Error ? error.message : 'Quota request failed.' });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, accounts.length) }, worker));
      if (this.controller.signal.aborted) return;
      this.state = this.summarize(results, this.state, Date.now()).map((provider, index) =>
        target && provider.provider !== target.provider ? this.state[index]! : provider);
    } catch (error) {
      if (this.controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : 'Unable to refresh accounts.';
      this.markError(message, target);
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
    this.controller.abort();
  }
}
