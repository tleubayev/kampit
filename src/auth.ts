import { createHmac, timingSafeEqual } from 'node:crypto';

export type TelegramUser = { id: number; first_name: string; last_name?: string; username?: string };
export type TelegramIdentity = { user: TelegramUser; startParam?: string };

export function verifyInitData(raw: string, botToken: string, nowSeconds = Math.floor(Date.now() / 1000)): TelegramIdentity {
  if (!raw || raw.length > 8192) throw new Error('Missing Telegram authentication');
  const params = new URLSearchParams(raw);
  const supplied = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  if (!supplied || !/^[a-f0-9]{64}$/i.test(supplied) || !Number.isSafeInteger(authDate) || authDate > nowSeconds + 30 || nowSeconds - authDate > 86400) {
    throw new Error('Expired or invalid Telegram authentication');
  }
  const check = [...params.entries()].filter(([key]) => key !== 'hash' && key !== 'signature')
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(check).digest();
  const received = Buffer.from(supplied, 'hex');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new Error('Invalid Telegram signature');
  let user: TelegramUser;
  try { user = JSON.parse(params.get('user') || 'null'); } catch { throw new Error('Invalid Telegram user'); }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0 || typeof user.first_name !== 'string') throw new Error('Invalid Telegram user');
  return { user, startParam: params.get('start_param') || undefined };
}
