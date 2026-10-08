import { Store } from '../src/store.ts';
const url = process.env.POSTGRES_MIGRATION_URL || '';
if (!url) throw new Error('POSTGRES_MIGRATION_URL is required');
const store = new Store('/tmp/unused.sqlite', 'UTC', url);
const metrics = store.dashboardMetrics();
console.log(JSON.stringify({ users: metrics.users, battles: metrics.battles, totalXp: metrics.totalXp }));
store.close();
