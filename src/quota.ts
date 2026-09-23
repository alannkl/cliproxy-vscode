import bundledPlanCapacities from './plan-capacities.json';

export const providers = ['claude', 'codex'] as const;
export type Provider = (typeof providers)[number];
export const providerNames: Record<Provider, string> = { claude: 'Claude', codex: 'Codex' };

export interface Account {
  id: string;
  name: string;
  provider: Provider;
  authIndex?: string;
  accountId?: string;
  planType?: string;
  disabled: boolean;
}

export interface QuotaWindow {
  label: string;
  seconds: number;
  used: number;
  resetAt?: number;
  overall: boolean;
  kind?: 'fable';
}

export interface AccountQuota {
  account: Account;
  windows: QuotaWindow[];
  updatedAt?: number;
  error?: string;
}

export interface QuotaReading {
  windows: QuotaWindow[];
  planType?: string;
}

export interface Summary {
  used: number;
  seconds: number;
  updatedAt: number;
  remainingUnits: number;
  totalUnits: number;
}

export type AccountMultipliers = Record<string, number>;
export type PlanCapacities = Record<Provider, Record<string, number>>;
export interface CapacityPolicy {
  accountMultipliers?: AccountMultipliers;
  planCapacities?: PlanCapacities;
}

export function parsePlanCapacities(value?: unknown): PlanCapacities {
  const result: PlanCapacities = { claude: { ...bundledPlanCapacities.claude }, codex: { ...bundledPlanCapacities.codex } };
  if (value === undefined) return result;
  const input = record(value);
  if (!input) throw new Error('Plan capacities must be an object keyed by provider and plan ID.');
  for (const [provider, entries] of Object.entries(input)) {
    if (provider !== 'claude' && provider !== 'codex') throw new Error('Plan capacities support the claude and codex providers.');
    const plans = record(entries);
    if (!plans || Object.entries(plans).some(([plan, capacity]) => !plan.trim()
      || typeof capacity !== 'number' || !Number.isFinite(capacity) || capacity <= 0 || capacity > 1000)) {
      throw new Error('Plan capacities must contain plan IDs with numbers greater than 0 and at most 1000.');
    }
    result[provider] = { ...result[provider], ...Object.fromEntries(Object.entries(plans).map(([plan, capacity]) => [plan.trim().toLowerCase(), capacity as number])) };
  }
  return result;
}

export function parseAccountMultipliers(value: unknown): AccountMultipliers {
  if (value === undefined) return {};
  const values = record(value);
  if (!values || Object.values(values).some(weight => typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0 || weight > 1000)) {
    throw new Error('Account multipliers must be numbers greater than 0 and at most 1000.');
  }
  return values as AccountMultipliers;
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
      planType: text(file.plan_type ?? record(file.metadata)?.plan_type ?? record(file.id_token)?.plan_type)?.toLowerCase(),
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
    const candidates = Array.isArray(data.limits) ? data.limits.map(record).filter(limit => {
      const model = record(record(limit?.scope)?.model);
      return text(limit?.kind)?.toLowerCase() === 'weekly_scoped'
        && ['fable', 'fable 5'].includes(text(model?.display_name)?.toLowerCase() ?? '');
    }) : [];
    const fable = candidates.find(limit => limit?.is_active === true) ?? candidates[0];
    for (const [key, value] of Object.entries(data)) {
      if (key === 'iguana_necktie' || key === 'seven_day_fable') continue;
      if (key !== 'five_hour' && !key.startsWith('seven_day')) continue;
      if (value == null) continue;
      const window = record(value);
      const overall = key === 'five_hour' || key === 'seven_day';
      // Claude also returns seven_day_breakdown metadata, which is not a quota window.
      if (!overall && (!window || !('utilization' in window))) continue;
      const seconds = key === 'five_hour' ? 18000 : 604800;
      const suffix = key.replace(/^seven_day_?/, '').replaceAll('_', ' ');
      const label = key === 'five_hour' || key === 'seven_day' ? windowLabel(seconds)
        : `${suffix} week`;
      windows.push({ label, seconds, used: percent(window?.utilization),
        resetAt: resetTime(window?.resets_at), overall });
    }
    const legacyFable = record(data.seven_day_fable ?? data.iguana_necktie);
    if (fable || legacyFable) {
      windows.push({ label: 'Fable week', kind: 'fable', seconds: 604800, overall: false,
        used: percent(fable ? fable.percent : legacyFable?.utilization),
        resetAt: resetTime((fable ?? legacyFable)?.resets_at) });
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

export function parseQuotaReading(provider: Provider, payload: unknown, now = Date.now()): QuotaReading {
  const data = jsonObject(payload);
  if (!data) throw new Error('Quota response is not a JSON object.');
  const rawPlan = data.plan_type ?? data.planType;
  const planType = text(rawPlan)?.toLowerCase();
  if (rawPlan != null && !planType) throw new Error('Quota response contains an invalid plan identifier.');
  return { windows: parseQuota(provider, data, now), planType };
}

export function claudeProfilePlan(payload: unknown): string | undefined {
  const profile = jsonObject(payload);
  return text(record(profile?.organization)?.rate_limit_tier)?.toLowerCase();
}

export function summarizeQuota(accounts: AccountQuota[], now: number, policy: CapacityPolicy = {}, selection: 'overall' | 'fable' = 'overall'): Summary | undefined {
  if (accounts.length === 0) return undefined;
  const selected = accounts.map(account => {
    if (account.error) throw new Error('Some accounts could not be refreshed.');
    const shortest = selection === 'fable' ? account.windows.find(w => w.kind === 'fable')
      : account.windows.filter(w => w.overall).sort((a, b) => a.seconds - b.seconds)[0];
    if (!shortest) throw new Error(`An account has no ${selection} quota window.`);
    return shortest;
  });
  const seconds = selected[0]!.seconds;
  if (selected.some(w => w.seconds !== seconds)) throw new Error('Accounts report different shortest quota windows.');
  const plans = policy.planCapacities ?? parsePlanCapacities();
  const overrides = policy.accountMultipliers ?? {};
  const samePlan = accounts.length === 1 || (accounts[0]!.account.planType !== undefined
    && accounts.every(a => a.account.planType === accounts[0]!.account.planType));
  const weights = accounts.map(({ account }) => (Object.hasOwn(overrides, account.name) ? overrides[account.name] : undefined)
    ?? (account.planType && Object.hasOwn(plans[account.provider], account.planType) ? plans[account.provider][account.planType] : undefined));
  // Equal plans can be compared without knowing their absolute capacity.
  // Unknown mixed plans require an explicit multiplier instead of a guessed total.
  const allUnknown = weights.every(weight => weight === undefined);
  const resolved = weights.map(weight => weight ?? (samePlan && allUnknown ? 1 : undefined));
  if (resolved.some(weight => weight === undefined)) throw new Error('Add unknown plans to planCapacities or set accountMultipliers for these accounts.');
  const multipliers = resolved as number[];
  const highest = Math.max(...multipliers);
  const totalUnits = multipliers.reduce((sum, weight) => sum + 100 * weight / highest, 0);
  const remainingUnits = selected.reduce((sum, window, index) => sum + (100 - window.used) * multipliers[index]! / highest, 0);
  return { used: 100 - remainingUnits / totalUnits * 100, seconds, updatedAt: now, remainingUnits, totalUnits };
}

export function summarizeFableQuota(accounts: AccountQuota[], now: number, policy: CapacityPolicy = {}): Summary | undefined {
  if (!accounts.length || accounts.some(account => !account.windows.some(window => window.kind === 'fable'))) return undefined;
  return summarizeQuota(accounts, now, policy, 'fable');
}

export function remainingPercent(used: number): number {
  return Math.round(100 - used);
}

export function quotaColor(used: number | undefined, stale = false): 'green' | 'orange' | 'red' | 'gray' {
  if (stale || used === undefined) return 'gray';
  return remainingColor(remainingPercent(used));
}

export function remainingColor(units: number | undefined, stale = false): 'green' | 'orange' | 'red' | 'gray' {
  if (stale || units === undefined) return 'gray';
  const remaining = Math.round(units);
  return remaining <= 20 ? 'red' : remaining <= 50 ? 'orange' : 'green';
}
