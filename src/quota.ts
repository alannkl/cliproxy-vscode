export const providers = ['claude', 'codex'] as const;
export type Provider = (typeof providers)[number];
export const providerNames: Record<Provider, string> = { claude: 'Claude', codex: 'Codex' };

export interface Account {
  id: string;
  name: string;
  provider: Provider;
  authIndex?: string;
  accountId?: string;
  disabled: boolean;
}

export interface QuotaWindow {
  label: string;
  seconds: number;
  used: number;
  resetAt?: number;
  overall: boolean;
}

export interface AccountQuota {
  account: Account;
  windows: QuotaWindow[];
  updatedAt?: number;
  error?: string;
}

export interface Summary {
  used: number;
  seconds: number;
  updatedAt: number;
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined;
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try { return record(JSON.parse(value)); } catch { return undefined; }
  }
  return record(value);
}

function codexAccountId(file: Record<string, unknown>): string | undefined {
  const sources = [file, record(file.metadata), record(file.attributes)];
  for (const source of sources) {
    const direct = text(source?.chatgpt_account_id ?? source?.chatgptAccountId);
    if (direct) return direct;
  }
  for (const source of sources) {
    const token = source?.id_token;
    let claims = jsonObject(token);
    if (!claims && typeof token === 'string' && token.split('.').length === 3) {
      claims = jsonObject(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
    }
    const auth = record(claims?.['https://api.openai.com/auth']) ?? claims;
    const id = text(auth?.chatgpt_account_id ?? auth?.chatgptAccountId);
    if (id) return id;
  }
  return undefined;
}

export function parseAccounts(payload: unknown): Account[] {
  const files = record(payload)?.files;
  if (!Array.isArray(files)) throw new Error('Invalid auth-files response: expected a files array.');
  const accounts: Account[] = [];
  const ids = new Set<string>();
  for (const value of files) {
    const file = record(value);
    if (!file) throw new Error('Invalid auth-files entry.');
    const provider = text(file.provider ?? file.type)?.toLowerCase();
    if (provider !== 'claude' && provider !== 'codex') continue;
    const name = text(file.name);
    if (!name) throw new Error('An auth file has no name.');
    const rawIndex = file.auth_index ?? file.authIndex;
    const authIndex = typeof rawIndex === 'number' && Number.isFinite(rawIndex)
      ? String(rawIndex) : text(rawIndex);
    const id = `${provider}:${authIndex ?? name}`;
    if (ids.has(id)) throw new Error('Duplicate auth-file identity.');
    ids.add(id);
    accounts.push({ id, name, provider, authIndex, accountId: codexAccountId(file),
      disabled: file.disabled === true || file.status === 'disabled' });
  }
  return accounts.sort((a, b) => a.name.localeCompare(b.name));
}

export function windowLabel(seconds: number): string {
  if (seconds === 604800) return 'week';
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${Math.round(seconds / 60)}m`;
}

function percent(value: unknown): number {
  const used = number(value);
  if (used === undefined || used < 0 || used > 100) {
    throw new Error('Quota response contains an invalid usage percentage.');
  }
  return used;
}

function resetTime(value: unknown): number | undefined {
  const numeric = number(value);
  const time = numeric !== undefined ? numeric * 1000 : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time > 0 ? time : undefined;
}

export function parseQuota(provider: Provider, payload: unknown, now = Date.now()): QuotaWindow[] {
  const data = jsonObject(payload);
  if (!data) throw new Error('Quota response is not a JSON object.');
  const windows: QuotaWindow[] = [];
  if (provider === 'claude') {
    for (const [key, value] of Object.entries(data)) {
      if (key !== 'five_hour' && !key.startsWith('seven_day') && key !== 'iguana_necktie') continue;
      if (value == null) continue;
      const window = record(value);
      const overall = key === 'five_hour' || key === 'seven_day';
      // Claude also returns seven_day_breakdown metadata, which is not a quota window.
      if (!overall && (!window || !('utilization' in window))) continue;
      const seconds = key === 'five_hour' ? 18000 : 604800;
      const suffix = key.replace(/^seven_day_?/, '').replaceAll('_', ' ');
      const label = key === 'five_hour' || key === 'seven_day' ? windowLabel(seconds)
        : key === 'iguana_necktie' ? 'Fable week' : `${suffix} week`;
      windows.push({ label, seconds, used: percent(window?.utilization),
        resetAt: resetTime(window?.resets_at), overall });
    }
  } else {
    const addLimit = (value: unknown, prefix: string, overall: boolean) => {
      if (value == null) return;
      const limit = record(value);
      if (!limit) throw new Error('Invalid Codex rate limit.');
      for (const raw of [limit.primary_window ?? limit.primaryWindow, limit.secondary_window ?? limit.secondaryWindow]) {
        if (raw == null) continue;
        const window = record(raw);
        const seconds = number(window?.limit_window_seconds ?? window?.limitWindowSeconds);
        if (seconds === undefined || seconds <= 0) throw new Error('Codex quota window duration is missing or invalid.');
        const relative = number(window?.reset_after_seconds ?? window?.resetAfterSeconds);
        windows.push({ label: `${prefix}${windowLabel(seconds)}`, seconds, overall,
          used: percent(window?.used_percent ?? window?.usedPercent),
          resetAt: resetTime(window?.reset_at ?? window?.resetAt)
            ?? (relative !== undefined && relative >= 0 ? now + relative * 1000 : undefined) });
      }
    };
    addLimit(data.rate_limit ?? data.rateLimit, '', true);
    addLimit(data.code_review_rate_limit ?? data.codeReviewRateLimit, 'Code review ', false);
    const additional = data.additional_rate_limits ?? data.additionalRateLimits;
    if (additional != null && !Array.isArray(additional)) throw new Error('Invalid additional Codex limits.');
    if (Array.isArray(additional)) for (const value of additional) {
      const limit = record(value);
      addLimit(limit?.rate_limit ?? limit?.rateLimit,
        `${text(limit?.limit_name ?? limit?.limitName ?? limit?.metered_feature) ?? 'Model'} `, false);
    }
  }
  if (!windows.some(w => w.overall)) throw new Error('No overall quota windows reported for this account.');
  return windows.sort((a, b) => Number(b.overall) - Number(a.overall) || a.seconds - b.seconds);
}

export function averageQuota(accounts: AccountQuota[], now: number): Summary | undefined {
  if (accounts.length === 0) return undefined;
  const selected = accounts.map(account => {
    if (account.error) throw new Error('Some accounts could not be refreshed.');
    const shortest = account.windows.filter(w => w.overall).sort((a, b) => a.seconds - b.seconds)[0];
    if (!shortest) throw new Error('An account has no overall quota window.');
    return shortest;
  });
  const seconds = selected[0]!.seconds;
  if (selected.some(w => w.seconds !== seconds)) throw new Error('Accounts report different shortest quota windows.');
  return { used: selected.reduce((sum, w) => sum + w.used, 0) / selected.length, seconds, updatedAt: now };
}

export function remainingPercent(used: number): number {
  return Math.round(100 - used);
}

export function quotaColor(used: number | undefined, stale = false): 'green' | 'orange' | 'red' | 'gray' {
  if (stale || used === undefined) return 'gray';
  const remaining = remainingPercent(used);
  return remaining <= 20 ? 'red' : remaining <= 50 ? 'orange' : 'green';
}
