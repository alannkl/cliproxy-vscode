import { promises as fs, watchFile, unwatchFile } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import lockfile from 'proper-lockfile';
import type { Cooldown, RefreshMode } from './client';
import { RefreshTarget, refreshCovers } from './client';
import type { ProviderQuota } from './monitor';
import { record, providers } from './quota';

export interface QuotaSnapshot {
  version: 1;
  revision: string;
  mode: RefreshMode;
  target?: RefreshTarget;
  // Partial snapshots retain the previous full check so other accounts still refresh on schedule.
  lastFullCheckedAt?: number;
  lastAttempt: number;
  lastCheckedAt: number;
  state: ProviderQuota[];
  cooldowns: Record<string, Cooldown>;
}

function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function optionalText(value: unknown): boolean { return value === undefined || typeof value === 'string'; }

function validAccounts(value: unknown, provider: string): boolean {
  return Array.isArray(value) && value.every(raw => {
    const entry = record(raw);
    const account = record(entry?.account);
    return entry && account && typeof account.id === 'string' && typeof account.name === 'string'
      && account.provider === provider && typeof account.disabled === 'boolean'
      && ['authIndex', 'accountId', 'planType'].every(key => optionalText(account[key]))
      && optionalText(entry.error) && (entry.updatedAt === undefined || finite(entry.updatedAt))
      && Array.isArray(entry.windows) && entry.windows.every(rawWindow => {
        const window = record(rawWindow);
        return window && typeof window.label === 'string' && typeof window.overall === 'boolean'
          && finite(window.used) && window.used >= 0 && window.used <= 100
          && finite(window.seconds) && window.seconds > 0
          && (window.kind === undefined || (window.kind === 'fable' && window.seconds === 604800 && window.overall === false))
          && (window.resetAt === undefined || finite(window.resetAt));
      });
  });
}

function validSnapshot(value: unknown): value is QuotaSnapshot {
  const snapshot = record(value);
  if (!snapshot || snapshot.version !== 1 || typeof snapshot.revision !== 'string'
    || !['automatic', 'manual'].includes(String(snapshot.mode))
    || !finite(snapshot.lastAttempt) || !finite(snapshot.lastCheckedAt)
    || (snapshot.lastFullCheckedAt !== undefined && !finite(snapshot.lastFullCheckedAt))
    || !Array.isArray(snapshot.state) || snapshot.state.length !== providers.length) return false;
  if (snapshot.target !== undefined) {
    const target = record(snapshot.target);
    if (!target || !providers.some(provider => provider === target.provider) || !optionalText(target.accountId)) return false;
  }
  if (!snapshot.state.every((raw, index) => {
    const state = record(raw);
    if (!state || state.provider !== providers[index] || !optionalText(state.error)
      || !validAccounts(state.accounts, String(state.provider))
      || (state.lastCompleteAccounts !== undefined && !validAccounts(state.lastCompleteAccounts, String(state.provider)))) return false;
    return [state.summary, state.fableSummary].every(value => {
      if (value === undefined) return true;
      const summary = record(value);
      return summary && finite(summary.used) && summary.used >= 0 && summary.used <= 100
        && finite(summary.seconds) && summary.seconds > 0 && finite(summary.updatedAt)
        && finite(summary.totalUnits) && summary.totalUnits > 0
        && finite(summary.remainingUnits) && summary.remainingUnits >= 0 && summary.remainingUnits <= summary.totalUnits;
    });
  })) return false;
  const cooldowns = record(snapshot.cooldowns);
  return cooldowns !== undefined && Object.values(cooldowns).every(raw => {
    const cooldown = record(raw);
    return cooldown && finite(cooldown.retryAt) && finite(cooldown.attempts)
      && Number.isInteger(cooldown.attempts) && cooldown.attempts > 0 && typeof cooldown.serverDirected === 'boolean';
  });
}

export class SharedQuotaCache {
  readonly path: string;

  constructor(directory: string, connectionKey: string) {
    if (!/^[a-f0-9]{64}$/.test(connectionKey)) throw new Error('Invalid shared cache identity.');
    this.path = join(directory, `${connectionKey}.json`);
  }

  async read(): Promise<QuotaSnapshot | undefined> {
    try {
      const value: unknown = JSON.parse(await fs.readFile(this.path, 'utf8'));
      return validSnapshot(value) ? value : undefined;
    } catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error('Cannot read the shared quota cache.');
    }
  }

  subscribe(onUpdate: (snapshot: QuotaSnapshot) => void): () => void {
    let active = true;
    const listener = () => {
      void this.read().then(snapshot => { if (active && snapshot) onUpdate(snapshot); }).catch(() => {});
    };
    watchFile(this.path, { interval: 1000, persistent: false }, listener);
    return () => { active = false; unwatchFile(this.path, listener); };
  }

  async refresh(mode: RefreshMode, intervalMs: number, signal: AbortSignal,
    fetchSnapshot: (previous: QuotaSnapshot | undefined, signal: AbortSignal) => Promise<QuotaSnapshot>,
    target?: RefreshTarget): Promise<QuotaSnapshot> {
    const requestedAt = Date.now();
    const cached = await this.read();
    const reusable = (snapshot: QuotaSnapshot | undefined) => snapshot && snapshot.lastCheckedAt <= Date.now()
      && (mode === 'automatic' ? Date.now() - (snapshot.target ? snapshot.lastFullCheckedAt ?? 0 : snapshot.lastCheckedAt) < intervalMs
        : snapshot.lastCheckedAt >= requestedAt
          && (snapshot.revision !== cached?.revision || snapshot.lastCheckedAt > requestedAt)
          && refreshCovers(snapshot.target, target)
          && (snapshot.mode === 'manual' || snapshot.state.every(provider => !provider.error)));
    if (reusable(cached)) return cached!;
    await fs.mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const lease = new AbortController();
    const combined = AbortSignal.any([signal, lease.signal, AbortSignal.timeout(70_000)]);
    let release: (() => Promise<void>) | undefined;
    while (!release) {
      combined.throwIfAborted();
      try {
        release = await lockfile.lock(this.path, { realpath: false, stale: 120_000, update: 10_000, retries: 0,
          onCompromised: () => lease.abort() });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ELOCKED') throw new Error('Cannot acquire the shared quota lock.');
        await delay(150, undefined, { signal: combined });
      }
    }
    try {
      combined.throwIfAborted();
      // Recheck after acquiring the lock: another window may have fetched while we waited.
      const latest = await this.read();
      if (reusable(latest)) return latest!;
      const snapshot = await fetchSnapshot(latest, combined);
      combined.throwIfAborted();
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600, flag: 'wx' });
        combined.throwIfAborted();
        await fs.rename(temporary, this.path);
      } finally {
        await fs.rm(temporary, { force: true });
      }
      return snapshot;
    } finally {
      await release();
    }
  }
}
