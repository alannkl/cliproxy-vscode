import { createServer, IncomingHttpHeaders } from 'node:http';
import { TestContext } from 'node:test';

export interface TestRequest { path: string; method?: string; headers: IncomingHttpHeaders; body: unknown }
interface Reply { status?: number; body?: unknown; headers?: Record<string, string>; hang?: boolean }

export async function serve(t: TestContext, handler: (request: TestRequest) => Reply | Promise<Reply>): Promise<string> {
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString('utf8');
      const reply = await handler({ path: request.url ?? '', method: request.method,
        headers: request.headers, body: raw ? JSON.parse(raw) : undefined });
      if (reply.hang) return;
      response.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json', ...reply.headers });
      response.end(JSON.stringify(reply.body));
    } catch {
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close(error => error ? reject(error) : resolve());
  }));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local server port.');
  return `http://127.0.0.1:${address.port}`;
}

export const weekly = (used: number) => ({ rate_limit: { primary_window: {
  used_percent: used, limit_window_seconds: 604800, reset_at: 1800000000,
} } });
