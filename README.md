# CLIProxy Usage

A small local VS Code extension for Claude and Codex quota remaining through CLIProxyAPI.

The status bar shows `🟢 C: 98%  🟠 X: 34%` in one compact button, so both providers stay together. Both percentages indicate quota remaining. Click to open the account sidebar. Hover for a combined preview of both providers and each account's windows, remaining bars, and reset countdowns. Unavailable readings show `⚪ C: -` or `⚪ X: -`.

Move the pointer into the hover preview to scroll through accounts. Its **Open full view** link also opens the sidebar. Preview bars follow the same green/orange/red thresholds as the sidebar; stale readings use gray.

## Install and connect

1. In VS Code, run **Extensions: Install from VSIX…** and choose `cliproxy-usage-0.1.0.vsix`.
2. Open **CLIProxy Quotas** in the Activity Bar and click **Configure Connection**, or run **CLIProxy Usage: Configure Connection** from the command palette.
3. Enter your VM URL, for example `http://your-vm:8317`, and its **management key**. This is the management API key, not an inference API key.

The URL is stored in the user setting `cliproxyUsage.baseUrl`. The key is stored in VS Code SecretStorage, separately for each server URL. Workspace settings cannot override the connection URL. The extension runs on your local computer, including when a workspace uses Remote SSH or WSL, so that computer must be connected to Tailscale.

CLIProxyAPI must allow remote management requests from your computer. A `403` can indicate that remote management is disabled; a `401` usually indicates a rejected management key. Check your server configuration if either appears in the sidebar.

## Quota display

- All quota percentages show **remaining**, calculated as 100 minus the API's percentage used. Each provider's status percentage is the equal-account average remaining, rounded to the nearest integer after averaging. Accounts with 20% and 80% remaining show 50%. This is not a capacity-weighted pool.
- The status uses the shortest **overall** window returned by that provider. A Codex `primary_window` with a duration of 604800 seconds is weekly, not 5-hour.
- The sidebar shows every account and quota window in full, with remaining-quota bars and reset countdowns. No rows need expanding. Long account names wrap; generated provider/hash prefixes and `.json` suffixes are omitted from the display, while the full filename appears on hover.
- The sidebar and each hover preview show one **Last checked** time after a refresh completes. Failed or stale readings remain labeled. Model-specific and code-review windows do not affect the provider average.
- All returned Claude and Codex accounts are included, including disabled accounts, which are labeled. Other providers are ignored.
- Green means more than 50% remaining, orange means 21–50%, and red means 20% or less, using the displayed percentage.
- Refresh runs on startup and every **5 minutes** by default. Set **CLIProxy Usage: Refresh Interval Minutes** in VS Code settings, or `"cliproxyUsage.refreshIntervalMinutes": 5` in user settings JSON. The setting accepts whole minutes from 1 to 1440 and applies immediately without clearing cached readings or cooldowns. Returning to a window also refreshes when the configured interval has elapsed since the last attempt. Use **CLIProxy Usage: Refresh** or the sidebar refresh button to refresh immediately.
- A provider quota HTTP 429 pauses that account's automatic requests. The extension honors a future `Retry-After` time. When it is missing, invalid, or zero, automatic retries wait 5 minutes, then 10, 20, and at most 30 minutes until a successful response. **Manual refresh retries immediately during this local fallback pause**; a future retry time explicitly supplied by the provider is still respected. Other accounts continue refreshing normally. This is a client retry policy, not a claim about the provider's rate limit. Each VS Code window has its own polling and cooldown state.

When any account fails, the provider keeps its last complete average with a neutral dot and a stale marker in its details. Successful account rows can still update. Failed rows retain their last reading and show the error. Missing data is never counted as zero. Without a complete previous reading, the provider shows `-`.

Accounts under a provider are expected to share quota windows. If the API reports different shortest windows, the extension marks the average unavailable or stale rather than combining different periods. Removing all accounts clears the provider's percentage. Cached readings are held only in memory and are cleared when the connection changes or VS Code reloads.

## Development

Requires Node.js 22 and VS Code 1.99 or newer.

```sh
npm ci
npm run check
npm run package
```

`npm run package` produces the local VSIX. Press F5 in this repository to launch an Extension Development Host, then configure its connection. The packaged extension has no runtime npm dependencies.

Tests run against a loopback HTTP server and cover the management protocol, provider parsing, averages, partial failures and recovery, timeouts, redirect rejection, configurable refresh scheduling, overlapping refreshes, and disposal during a request. When connecting a new server, verify its deployed CLIProxy version and compare its account responses with the extension. These automated tests do not exercise the VS Code UI.

## Integration contract

The extension makes only quota-read requests:

- `GET /v0/management/auth-files`, authenticated with `Authorization: Bearer <management key>`.
- `POST /v0/management/api-call`, with `auth_index`, upstream `method: GET`, `url`, and `header`. CLIProxy substitutes the literal `Bearer $TOKEN$` header using the selected account, so the extension does not download auth files or persist provider tokens.
- Claude uses `https://api.anthropic.com/api/oauth/usage` with `anthropic-beta: oauth-2025-04-20`.
- Codex uses `https://chatgpt.com/backend-api/wham/usage`, with `Chatgpt-Account-Id` when the auth-file metadata exposes it.

Both management HTTP status and the proxy response's `status_code` must succeed. The proxy `body` may be JSON text or an object. Requests have a 15-second timeout, refresh cycles have a 50-second deadline, and at most four account requests run at once. Overlapping refreshes share one cycle. Redirects are rejected, and arbitrary upstream error bodies are not displayed or logged.

Quota requests and response shapes were checked against the [upstream management client at commit 4530da2](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/tree/4530da271ba2e89810d4dccebc57f3091afa590a/src/features/quota/providers) and the [CLIProxyAPI management handler](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/api/handlers/management/api_tools.go). Unknown or malformed quota data is reported as unavailable.
