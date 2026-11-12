import type { Engine } from './engine.ts';

export const MARKET_PRODUCT = 'BTC-USD';

export function activateMarket(engine: Engine, product = MARKET_PRODUCT) {
  const row = engine.store.db.prepare("SELECT value FROM app_meta WHERE key='market_product'").get() as { value: string } | undefined;
  if (row?.value === product) return [];

  const active = engine.store.db.prepare("SELECT id FROM battles WHERE status IN ('lobby','countdown','live')").all() as { id: string }[];
  for (const battle of active) engine.void(battle.id);
  engine.store.db.prepare("INSERT OR REPLACE INTO app_meta(key,value) VALUES('market_product',?)").run(product);
  return active.map(battle => battle.id);
}
