import { Worker } from 'node:worker_threads';

type RunResult = { changes: number };
export class SyncPostgresDatabase {
  private worker: Worker;
  private shared = new SharedArrayBuffer(2 * 1024 * 1024);
  private signal = new Int32Array(this.shared, 0, 2);
  private output = new Uint8Array(this.shared, 8);
  constructor(url: string) {
    this.worker = new Worker(new URL('./postgres-worker.ts', import.meta.url), { workerData: { url, shared: this.shared } });
  }
  private call(op: string, query = '', params: unknown[] = []) {
    Atomics.store(this.signal, 0, 0); Atomics.store(this.signal, 1, 0);
    this.worker.postMessage({ op, query, params });
    const wait = Atomics.wait(this.signal, 0, 0, 30_000);
    if (wait === 'timed-out') throw new Error('PostgreSQL query timed out');
    const size = Atomics.load(this.signal, 1);
    const parsed = JSON.parse(Buffer.from(this.output.slice(0, size)).toString()) as { value?: unknown; error?: string };
    if (parsed.error) throw new Error(parsed.error);
    return parsed.value;
  }
  prepare(query: string) {
    return {
      run: (...params: unknown[]) => this.call('run', query, params) as RunResult,
      get: (...params: unknown[]) => this.call('get', query, params),
      all: (...params: unknown[]) => this.call('all', query, params) as unknown[]
    };
  }
  exec(query: string) { this.call('exec', query); }
  close() { try { this.call('close'); } finally { void this.worker.terminate(); } }
}
