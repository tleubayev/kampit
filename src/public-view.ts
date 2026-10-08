import type { Account, Battle, Player } from './store.ts';

type StatsRow = { user_id: string; name: string; wins: number; losses: number; ties: number; streak: number; xp: number };

export function publicBattle(battle: Battle, userId: string, paid?: { stake_minor: number; settlement_status: string }) {
  return {
    id: battle.id,
    status: battle.status,
    created_at: battle.created_at,
    lobby_deadline: battle.lobby_deadline,
    countdown_at: battle.countdown_at,
    start_at: battle.start_at,
    lock_at: battle.lock_at,
    end_at: battle.end_at,
    start_price: battle.start_price,
    end_price: battle.end_price,
    outcome: battle.outcome,
    stake: battle.stake,
    mode: paid ? 'USDC_TEST' : 'XP',
    maxPlayers: paid ? 10 : 100,
    stakeMinor: paid?.stake_minor,
    settlementStatus: paid?.settlement_status,
    isCreator: battle.creator_user_id === userId,
  };
}

export function publicPlayers(players: Player[], battle: Battle, userId: string, now: number) {
  return players.map(player => ({
    name: player.name,
    ready: Boolean(player.ready),
    prediction: battle.status === 'live' && now < battle.lock_at! && player.user_id !== userId ? null : player.prediction,
    isYou: player.user_id === userId,
  }));
}

export function publicStats(row: StatsRow | undefined) {
  if (!row) return null;
  return { name: row.name, wins: row.wins, losses: row.losses, ties: row.ties, streak: row.streak, xp: row.xp };
}

export function publicAccount(account: Account) { return { balance: account.balance }; }
