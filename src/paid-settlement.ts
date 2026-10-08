export const HOUSE_FEE_BPS = 100;

export type PaidDistribution = {
  houseMinor: number;
  payouts: Map<string, number>;
  refunds: Map<string, number>;
};

export function paidDistribution(entrantIds: string[], winnerIds: string[], stakeMinor: number, houseWins: boolean, voidRound = false): PaidDistribution {
  const payouts = new Map<string, number>(), refunds = new Map<string, number>();
  const pool = entrantIds.length * stakeMinor;
  if (voidRound || (!houseWins && !winnerIds.length)) {
    for (const userId of entrantIds) refunds.set(userId, stakeMinor);
    return { houseMinor: 0, payouts, refunds };
  }
  if (houseWins) return { houseMinor: pool, payouts, refunds };
  const houseMinor = Math.floor(pool * HOUSE_FEE_BPS / 10_000);
  const prizeMinor = pool - houseMinor;
  for (let index = 0; index < winnerIds.length; index++) {
    payouts.set(winnerIds[index], Math.floor(prizeMinor / winnerIds.length) + (index < prizeMinor % winnerIds.length ? 1 : 0));
  }
  return { houseMinor, payouts, refunds };
}
