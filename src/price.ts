export type Quote = { price: number; at: number; sourceTime: string };

export class CoinbasePriceFeed {
  latest: Quote | null = null;
  history: Quote[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  async refresh(): Promise<Quote> {
    if (this.busy) {
      if (this.latest) return this.latest;
      throw new Error('Price refresh in progress');
    }
    this.busy = true;
    try {
      const response = await fetch('https://api.exchange.coinbase.com/products/SOL-USD/ticker', {
        headers: { 'User-Agent': 'SOLQuickBattle/0.1', Accept: 'application/json' },
        signal: AbortSignal.timeout(4000)
      });
      if (!response.ok) throw new Error(`Price API ${response.status}`);
      const data = await response.json() as { price?: string; time?: string };
      const price = Number(data.price);
      const sourceMs = Date.parse(data.time || '');
      const now = Date.now();
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(sourceMs) || Math.abs(now - sourceMs) > 10000) throw new Error('Stale price from provider');
      const quote = { price, at: now, sourceTime: data.time! };
      this.latest = quote;
      this.history.push(quote);
      this.history = this.history.filter(q => q.at >= now - 120000);
      return quote;
    } finally { this.busy = false; }
  }
  start() {
    void this.refresh().catch(error => console.error('Price feed:', error.message));
    this.timer = setInterval(() => void this.refresh().catch(error => console.error('Price feed:', error.message)), 2000);
  }
  stop() { if (this.timer) clearInterval(this.timer); }
  fresh(now = Date.now()) { return this.latest && now - this.latest.at <= 5000 ? this.latest : null; }
}
