import { CLIProxyClient, RefreshMode } from '../src/client';
import { QuotaMonitor } from '../src/monitor';
import { SharedQuotaCache } from '../src/shared-cache';
import { setTimeout as delay } from 'node:timers/promises';

async function main(): Promise<void> {
  const [url, directory, mode, startAt] = process.argv.slice(2);
  if (!url || !directory || (mode !== 'manual' && mode !== 'automatic')) throw new Error('Invalid worker arguments.');
  const wait = Number(startAt) - Date.now();
  if (wait > 0) await delay(wait);
  const client = new CLIProxyClient(url, 'test-key');
  const monitor = new QuotaMonitor(client, () => {}, 300000, { sharedCache: new SharedQuotaCache(directory, client.cacheKey) });
  try {
    await monitor.refresh(mode as RefreshMode);
    process.stdout.write(JSON.stringify({ state: monitor.state, lastCheckedAt: monitor.lastCheckedAt }));
  } finally { monitor.dispose(); }
}

void main().catch(() => { process.stderr.write('Cache worker failed.'); process.exitCode = 1; });
