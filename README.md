# CLIProxy Usage

A small local VS Code extension for Claude and Codex quota remaining through CLIProxyAPI.

The status bar shows `🟢 C: 98%/94%  🟢 X: 43%` in one compact button. Claude shows **5-hour / Fable weekly** remaining; Codex shows its shortest overall window. Percentages show the capacity-weighted fraction remaining; provider icon colors show the remaining capacity in units of the largest account. For example, 95 units left out of 220 displays **43% with a green icon**. Click to open the account sidebar, or hover for provider totals, account windows, colored bars, and reset countdowns. Unavailable readings show `-`, such as `⚪ C: 98%/-`.

Move the pointer into the hover preview to scroll through accounts. Its **Open full view** link also opens the sidebar. The compact preview omits repeated column headings. Preview bars follow the same green/orange/red thresholds as the sidebar; stale warnings appear on affected accounts, and healthy account bars keep their colors.

## Install and connect

1. In VS Code, run **Extensions: Install from VSIX…** and choose `cliproxy-usage-0.1.0.vsix`.
2. Open **CLIProxy Quotas** in the Activity Bar and click **Configure Connection**, or run **CLIProxy Usage: Configure Connection** from the command palette.
3. Enter your VM URL, for example `http://your-vm:8317`, and its **management key**. This is the management API key, not an inference API key.

The URL is stored in the user setting `cliproxyUsage.baseUrl`. The key is stored in VS Code SecretStorage, separately for each server URL. Workspace settings cannot override the connection URL. The extension runs on your local computer, including when a workspace uses Remote SSH or WSL, so that computer must be connected to Tailscale.

CLIProxyAPI must allow remote management requests from your computer. A `403` can indicate that remote management is disabled; a `401` usually indicates a rejected management key. Check your server configuration if either appears in the sidebar.

## Quota display

- Each account shows its own percentage **remaining**, calculated as 100 minus the API's percentage used. Provider totals weight those percentages by plan capacity. The largest account in each provider is worth **100 units**; other accounts contribute proportionally. Two 5× accounts and one 1× account have 100 + 100 + 20 = **220 units**. At 22%, 73%, and 0% remaining, they have **95/220 units** left, displayed as **43%**.
- Plan capacities live in [the bundled registry](src/plan-capacities.json), with overrides in the user setting `cliproxyUsage.planCapacities`, keyed by provider and reported plan ID. Codex entries include Pro Lite 5×, Pro 20×, and Plus/Team 1×. Claude entries include Pro 1×, Max 5×, and Max 20×. These are relative plan multipliers, not token limits guaranteed by the provider. A single account is always a 100-unit reference; accounts with the same reported plan can be weighted equally. Unknown or mixed plans without enough capacity information show an explanation instead of a guessed total.
- A successful quota response's plan ID takes priority over auth-file metadata. For Claude, a profile lookup after a successful quota read identifies the precise `organization.rate_limit_tier`, including Max 5× versus Max 20×. Upgrades and downgrades update capacities on the next successful plan lookup. The sidebar and preview show the last reported plan beside the account name. If the optional profile lookup fails, quota windows remain available; a generic Max flag is never used to guess its tier.
- Multiple Claude accounts are combined separately for **5-hour** and **Fable weekly** quota. A Max 5× plus a Max 20× account provides 25 + 100 = **125 units** in each window. If an account has no Fable reading, the combined Fable value stays unavailable rather than treating it as zero or full.
- Use `cliproxyUsage.accountMultipliers` only for exceptions or providers that do not report a precise plan tier. It is keyed by full auth filename, for example `{ "first.json": 5, "second.json": 1 }`, and takes priority over the plan registry. Remove an account override to follow its reported plan automatically. Capacities must be greater than zero and at most 1000; registry and override edits immediately recalculate cached totals without another quota fetch.
- Codex status uses its shortest **overall** window. A `primary_window` with a duration of 604800 seconds is weekly, not 5-hour. Claude status shows **5-hour / Fable weekly** separately. Fable is read from its `weekly_scoped` entry in `limits`, with the legacy Fable field as a fallback; it does not replace the overall weekly window in account details.
- The sidebar shows every account and quota window in full, with remaining-quota bars and reset countdowns. No rows need expanding. Long account names wrap; generated provider/hash prefixes and `.json` suffixes are omitted from the display, while the full filename appears on hover.
- The sidebar and each hover preview show one **Last checked** time for the most recent refresh, including a provider or account refresh. Other accounts retain their previous readings and freshness. Failed or stale readings remain labeled. Overall capacity totals exclude model-specific and code-review windows; Claude's Fable quota has its own separate total.
- All returned Claude and Codex accounts are included, including disabled accounts, which are labeled. Other providers are ignored.
- Provider icons are green above **50 remaining units**, orange at **21–50 units**, and red at **20 units or less**. Claude's icon uses the lower remaining-unit total of its 5-hour and Fable windows; if either is unavailable, it is gray. Account bars use the same thresholds on that account's remaining percentage. Both use rounded values. The preview shows remaining/total units so a green icon beside a percentage below 50% is explained.
- Refresh runs on startup and every **5 minutes** by default. Set **CLIProxy Usage: Refresh Interval Minutes** in VS Code settings, or `"cliproxyUsage.refreshIntervalMinutes": 5` in user settings JSON. The setting accepts whole minutes from 1 to 1440 and applies immediately without clearing cached readings or cooldowns. Returning to a window also refreshes when the configured interval has elapsed since the last attempt. Use **CLIProxy Usage: Refresh** or the sidebar refresh button to refresh immediately.
- In the full sidebar, **Refresh** beside a provider checks all accounts under that provider. **Refresh** beside an account checks only that account, even when it shares a provider with other accounts. The existing sidebar toolbar refresh button and **CLIProxy Usage: Refresh** still refresh all providers and accounts. Provider and account refreshes follow the same cooldown rules and do not postpone automatic refreshes of the other accounts.
- A provider quota HTTP 429 pauses that account's automatic requests. The extension honors a future `Retry-After` time. When it is missing, invalid, or zero, automatic retries wait 5 minutes, then 10, 20, and at most 30 minutes until a successful response. **Manual refresh retries immediately during this local fallback pause**; a future retry time explicitly supplied by the provider is still respected. Other accounts continue refreshing normally. Cooldowns are shared across windows. This is a client retry policy, not a claim about the provider's rate limit.

When any account fails, the provider keeps its last complete capacity total with a neutral dot. Successful account rows can still update and keep their colors. Failed rows retain their last reading, use gray bars, and show the error once at account level. Connection errors remain visible when no accounts have loaded. Missing data is never counted as zero. Without a complete previous reading, the provider shows `-`.

Accounts under a provider are expected to share quota windows. If the API reports different shortest windows, the extension marks the total unavailable or stale rather than combining different periods. Removing all accounts clears the provider's percentage.

For example, this user setting updates the plan list for every matching Codex account:

```json
"cliproxyUsage.planCapacities": {
  "codex": {
    "prolite": 5,
    "pro": 20,
    "team": 1,
    "plus": 1
  },
  "claude": {
    "default_claude_pro": 1,
    "default_claude_max_5x": 5,
    "default_claude_max_20x": 20
  }
}
```

Entries merge with the bundled list. Add new provider-reported plan IDs here when needed; no calculation code needs changing. Use a per-account override when a provider does not report a usable plan ID.

## Sharing across windows

Windows in the same Cursor or VS Code profile share a cache and cross-process lock for each CPA connection. Automatic refreshes reuse a fresh snapshot. Concurrent manual refreshes share a fetch when it covers the requested provider or account; other targets wait for the lock and refresh their own accounts. Another manual refresh after completion requests new data. Claude usage and profile lookups both run under this lock. Other windows pick up saved updates within about a second without calling the provider again.

The cache lives under the editor profile's extension storage, in `quota-cache`. It contains account names, normalized quota readings, the last complete totals, and cooldowns. Management keys and OAuth tokens are never stored in it. The cache identity hashes the normalized server URL and management key, so different connections cannot reuse each other's data. Snapshots are written atomically with owner-only permissions where supported.

The lock covers account discovery and the quota requests. A crashed owner's lock becomes recoverable after two minutes without a heartbeat. If the cache or lock cannot be used, the extension reports an error instead of making uncoordinated requests. Different editor profiles, different machines, and the CPA web UI do not share this cache. Close or update older extension windows, since old versions do not participate in the lock.

## Development

Requires Node.js 22 and VS Code 1.99 or newer.

```sh
npm ci
npm run check
npm run package
```

`npm run package` produces the local VSIX, including the small `proper-lockfile` dependency used for cross-window coordination. Press F5 in this repository to launch an Extension Development Host, then configure its connection.

Tests use a loopback HTTP server and real child processes. They cover weighted capacity, shared fetches, manual refresh coalescing, cache notifications, cooldown recovery, terminated lock owners, connection isolation, malformed caches, requests, scheduling, and presentation. When connecting a new server, compare its account responses with the extension. These automated tests do not exercise the VS Code UI.

## Integration contract

The extension makes only quota-read requests:

- `GET /v0/management/auth-files`, authenticated with `Authorization: Bearer <management key>`.
- `POST /v0/management/api-call`, with `auth_index`, upstream `method: GET`, `url`, and `header`. CLIProxy substitutes the literal `Bearer $TOKEN$` header using the selected account, so the extension does not download auth files or persist provider tokens.
- Claude uses `https://api.anthropic.com/api/oauth/usage` with `anthropic-beta: oauth-2025-04-20`, followed by `https://api.anthropic.com/api/oauth/profile` to read its plan tier.
- Codex uses `https://chatgpt.com/backend-api/wham/usage`, with `Chatgpt-Account-Id` when the auth-file metadata exposes it.

Both management HTTP status and the proxy response's `status_code` must succeed. The proxy `body` may be JSON text or an object. Requests have a 15-second timeout, refresh cycles have a 50-second deadline, and at most four account requests run at once. Overlapping refreshes share a cycle when it covers the requested accounts; otherwise they queue. Redirects are rejected, and arbitrary upstream error bodies are not displayed or logged.

Quota requests and response shapes were checked against the [upstream management client at commit 4530da2](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/tree/4530da271ba2e89810d4dccebc57f3091afa590a/src/features/quota/providers) and the [CLIProxyAPI management handler](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/api/handlers/management/api_tools.go). Unknown or malformed quota data is reported as unavailable.
