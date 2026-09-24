import { Account, Provider, parseAccounts, parseQuotaReading, claudeProfilePlan, QuotaReading, record } from './quota';
import { createHash } from 'node:crypto';

export type RefreshMode = 'automatic' | 'manual';
// An omitted target refreshes all accounts; an omitted accountId selects the provider.
export interface RefreshTarget { provider: Provider; accountId?: string }

export function refreshCovers(target: RefreshTarget | undefined, requested: RefreshTarget | undefined): boolean {
  return !target || Boolean(requested && target.provider === requested.provider
    && (target.accountId === undefined || target.accountId === requested.accountId));
}

export interface Cooldown { retryAt: number; attempts: number; serverDirected: boolean }

function retryAfter(header: unknown, now: number): number | undefined {
  const headers = record(header);
  const value = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const seconds = Number(raw);
  const at = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(raw);
  return Number.isFinite(at) && at > now && at <= 8.64e15 ? at : undefined;
}

function rateLimitError(retryAt: number): Error {
  return new Error(`Provider quota API returned HTTP 429. Checks paused until ${new Date(retryAt).toLocaleTimeString()}.`);
}

export function normalizeBaseUrl(input: string): string {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error('Enter an HTTP or HTTPS server URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTP or HTTPS URL without credentials, query parameters, or a fragment.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v0\/management$/, '');
  return url.toString().replace(/\/+$/, '');
}

export class CLIProxyClient {
  readonly baseUrl: string;
  private readonly cooldowns = new Map<string, Cooldown>();

  get cacheKey(): string {
    return createHash('sha256').update(this.baseUrl).update('\0').update(this.managementKey).digest('hex');
  }

  exportCooldowns(): Record<string, Cooldown> { return Object.fromEntries(this.cooldowns); }

  importCooldowns(cooldowns: Record<string, Cooldown>): void {
    this.cooldowns.clear();
    for (const [id, cooldown] of Object.entries(cooldowns)) this.cooldowns.set(id, cooldown);
  }

  constructor(baseUrl: string, private readonly managementKey: string, private readonly timeoutMs = 15000) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    if (!managementKey.trim()) throw new Error('Configure a management key first.');
  }

  private async request(path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
    let response: Response;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    try {
      response = await fetch(`${this.baseUrl}/v0/management/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${this.managementKey}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: combined,
      });
      if (!response.ok) {
        await response.body?.cancel();
        const hint = response.status === 401 ? ' Check the management key.'
          : response.status === 403 ? ' Check remote management access and the management key.' : '';
        throw new RequestError(`Management API returned HTTP ${response.status}.${hint}`);
      }
      try { return await response.json(); }
      catch {
        if (combined.aborted) throw new RequestError('CLIProxy request timed out or was cancelled.');
        throw new RequestError('Management API returned invalid JSON.');
      }
    } catch (error) {
      if (error instanceof RequestError) throw error;
      if (combined.aborted) throw new Error('CLIProxy request timed out or was cancelled.');
      // Never expose arbitrary upstream bodies, headers, or fetch error details.
      throw new Error('Cannot reach CLIProxy. Check the URL, Tailscale connection, and server. Redirects are not followed.');
    }
  }

  async accounts(signal: AbortSignal): Promise<Account[]> {
    return parseAccounts(await this.request('auth-files', signal));
  }

  async quota(account: Account, signal: AbortSignal, mode: RefreshMode = 'automatic'): Promise<QuotaReading> {
    if (!account.authIndex) throw new Error('Auth file has no auth_index. Check the CLIProxy version and credential.');
    const cooldown = this.cooldowns.get(account.id);
    if (cooldown && Date.now() < cooldown.retryAt && (mode === 'automatic' || cooldown.serverDirected)) {
      const until = new Date(cooldown.retryAt).toLocaleTimeString();
      throw new Error(cooldown.serverDirected
        ? `Checks paused until ${until} as requested by the provider after an earlier HTTP 429.`
        : `Checks paused locally until ${until} after an earlier HTTP 429. Use Refresh to retry now.`);
    }
    const header: Record<string, string> = { Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json' };
    if (account.provider === 'claude') header['anthropic-beta'] = 'oauth-2025-04-20';
    else {
      header['User-Agent'] = 'codex-tui/0.149.1';
      if (account.accountId) header['Chatgpt-Account-Id'] = account.accountId;
    }
    const envelope = record(await this.request('api-call', signal, {
      auth_index: account.authIndex, method: 'GET', header,
      url: account.provider === 'claude' ? 'https://api.anthropic.com/api/oauth/usage'
        : 'https://chatgpt.com/backend-api/wham/usage',
    }));
    const status = envelope?.status_code;
    if (typeof status !== 'number' || !Number.isInteger(status)) throw new Error('Invalid api-call response status.');
    if (status === 429) {
      const now = Date.now();
      const attempts = (cooldown?.attempts ?? 0) + 1;
      // The OAuth usage endpoint can return Retry-After: 0 even while rejecting requests.
      const fallback = Math.min(5 * 60_000 * 2 ** Math.min(attempts - 1, 3), 30 * 60_000);
      const serverRetryAt = retryAfter(envelope?.header, now);
      const retryAt = serverRetryAt ?? now + fallback;
      this.cooldowns.set(account.id, { retryAt, attempts, serverDirected: serverRetryAt !== undefined });
      throw rateLimitError(retryAt);
    }
    if (status < 200 || status >= 300) throw new Error(`Provider quota API returned HTTP ${status}.`);
    const reading = parseQuotaReading(account.provider, envelope?.body);
    this.cooldowns.delete(account.id);
    if (account.provider === 'claude') {
      try {
        const profile = record(await this.request('api-call', signal, {
          auth_index: account.authIndex, method: 'GET', header,
          url: 'https://api.anthropic.com/api/oauth/profile',
        }));
        if (profile?.status_code === 200) reading.planType = claudeProfilePlan(profile.body) ?? reading.planType;
      } catch {
        // Quota remains useful if optional plan metadata is unavailable. Mixed unknown plans require overrides.
      }
    }
    return reading;
  }
}

class RequestError extends Error {}
