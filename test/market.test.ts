import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.ts';
import { Engine } from '../src/engine.ts';
import { activateMarket, MARKET_PRODUCT } from '../src/market.ts';

test('market migration voids unfinished rounds, refunds XP, and runs only once', () => {
  const store = new Store(':memory:');
  const engine = new Engine(store);
  const battle = engine.create('group', 100, '1');
  engine.join(battle.id, '1', 'Ali');
  engine.ready(battle.id, '1');

  assert.equal(store.account('1')?.balance, 900);
  assert.deepEqual(activateMarket(engine), [battle.id]);
  assert.equal(engine.require(battle.id).status, 'void');
  assert.equal(store.account('1')?.balance, 1000);
  assert.equal((store.db.prepare("SELECT value FROM app_meta WHERE key='market_product'").get() as { value: string }).value, MARKET_PRODUCT);
  assert.deepEqual(activateMarket(engine), []);
  assert.equal(store.account('1')?.balance, 1000);
  store.close();
});

test('Coinbase feed requests BTC-USD and records the quote', async () => {
  const originalFetch = globalThis.fetch;
  let requested = '';
  globalThis.fetch = (async (input: string | URL | Request) => {
    requested = String(input);
    return new Response(JSON.stringify({ price: '94731.25', time: new Date().toISOString() }), { status: 200 });
  }) as typeof fetch;
  try {
    const { CoinbasePriceFeed } = await import('../src/price.ts');
    const feed = new CoinbasePriceFeed();
    const quote = await feed.refresh();
    assert.equal(requested, 'https://api.exchange.coinbase.com/products/BTC-USD/ticker');
    assert.equal(quote.price, 94731.25);
    assert.equal(feed.history.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
