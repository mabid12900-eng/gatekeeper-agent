import http from 'node:http';

/**
 * Tiny in-process fake of the Upstash Redis REST API, for OFFLINE tests.
 *
 * Protocol it mimics (what RedisStore uses):
 *   POST /  with body = JSON array of command parts, e.g.
 *           ["SET","key","value","NX","EX",2592000]  -> {"result":"OK"} or {"result":null}
 *           ["GET","key"]                            -> {"result":"value"} or {"result":null}
 *   Authorization: Bearer <token>
 *
 * Supports TTLs, NX, and an artificial delay (for timeout tests).
 */
export interface FakeRedisOptions {
  token?: string;
  /** Delay every command by this many milliseconds (timeout tests). */
  delayMs?: number;
}

export interface FakeRedis {
  port: number;
  close(): Promise<void>;
}

export async function startFakeRedis(options: FakeRedisOptions = {}): Promise<FakeRedis> {
  const token = options.token ?? 'test-token';
  const delayMs = options.delayMs ?? 0;
  const db = new Map<string, { value: string; expiresAt: number }>();

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const apply = (): void => {
        try {
          const args = JSON.parse(raw) as (string | number)[];
          const command = String(args[0]).toUpperCase();
          let result: unknown = null;

          if (command === 'SET') {
            const key = String(args[1]);
            const value = String(args[2]);
            const rest = args.slice(3).map((a) => String(a).toUpperCase());
            const hasNx = rest.includes('NX');
            const exIndex = rest.indexOf('EX');
            const ttlSeconds = exIndex >= 0 ? Number(args[3 + exIndex]) : 0;
            const existing = db.get(key);
            const live =
              existing !== undefined && (existing.expiresAt === 0 || existing.expiresAt > Date.now())
                ? existing
                : undefined;
            if (existing !== undefined && live === undefined) {
              db.delete(key); // expired entry cleanup only
            }
            if (hasNx && live !== undefined) {
              result = null; // set-if-not-exists: key already live -> fail
            } else {
              db.set(key, {
                value,
                expiresAt: ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : 0,
              });
              result = 'OK';
            }
          } else if (command === 'GET') {
            const key = String(args[1]);
            const entry = db.get(key);
            if (entry === undefined) {
              result = null;
            } else if (entry.expiresAt !== 0 && entry.expiresAt <= Date.now()) {
              db.delete(key);
              result = null;
            } else {
              result = entry.value;
            }
          } else {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: `unsupported command ${command}` }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ result }));
        } catch (e) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : 'bad request' }));
        }
      };
      if (delayMs > 0) setTimeout(apply, delayMs);
      else apply();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');

  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
