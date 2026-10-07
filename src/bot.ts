import type { Engine } from './engine.ts';
import type { Battle } from './store.ts';
import { SlidingWindowRateLimiter } from './rate-limit.ts';

type TgUser = { id: number; first_name: string; last_name?: string };
type TgMessage = { message_id: number; chat: { id: number; type: string }; from?: TgUser; text?: string; migrate_to_chat_id?: number; migrate_from_chat_id?: number };
type Update = { update_id: number; message?: TgMessage; callback_query?: { id: string; from: TgUser; message?: TgMessage; data?: string } };

export class Bot {
  private token: string; private username: string; private shortName: string; private engine: Engine;
  private payTesters: Set<string>;
  private battleLimiter = new SlidingWindowRateLimiter();
  private warningLimiter = new SlidingWindowRateLimiter();
  constructor(token: string, username: string, shortName: string, engine: Engine, payTesters = new Set<string>()) { this.token=token; this.username=username; this.shortName=shortName; this.engine=engine; this.payTesters=payTesters; }
  link(id: string) { return `https://t.me/${this.username}/${this.shortName}?startapp=${id}`; }
  async call(method: string, body: Record<string, unknown>) {
    const response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000)
    });
    const result = await response.json() as { ok: boolean; result?: any; description?: string; parameters?: { migrate_to_chat_id?: number } };
    if ((!response.ok || !result.ok) && result.parameters?.migrate_to_chat_id && body.chat_id != null) {
      const nextId = String(result.parameters.migrate_to_chat_id);
      if (nextId !== String(body.chat_id)) {
        this.engine.store.migrateChat(String(body.chat_id), nextId);
        return this.call(method, { ...body, chat_id: nextId });
      }
    }
    if (!response.ok || !result.ok) throw new Error(`Telegram ${method}: ${result.description || response.status}`);
    return result.result;
  }
  async setup(appUrl: string, secret: string) {
    await this.call('setWebhook', { url: `${appUrl.replace(/\/$/, '')}/telegram/webhook`, secret_token: secret, allowed_updates: ['message', 'callback_query'], drop_pending_updates: false });
    await this.call('setMyCommands', { commands: [
      { command: 'battle', description: 'Start a SOL quick battle' },
      { command: 'leaderboard', description: 'Group XP leaderboard' },
      { command: 'stats', description: 'Your group stats' },
      { command: 'referral', description: 'Get your invite link' },
      { command: 'cancel', description: 'Cancel your open lobby' },
      { command: 'help', description: 'How to play' }
    ] });
  }
  async card(battle: Battle) {
    const paid = this.engine.store.paidBattle(battle.id);
    const stakeLabel = paid ? `${(paid.stake_minor / 1_000_000).toFixed(2)} TEST USDC` : `${battle.stake} XP`;
    const sent = await this.call('sendMessage', {
      chat_id: battle.chat_id,
      text: `⚔️ SOL QUICK BATTLE · ${stakeLabel} STAKE${paid ? '\n🧪 PRIVATE DEVNET TEST · TOKENS HAVE NO VALUE' : ''}\n\nReady up to lock ${stakeLabel}. The lobby runs for 30 seconds after the first player readies up; unready players are excluded. Predict SOL/USD over 60 seconds. 2–100 players.`,
      reply_markup: { inline_keyboard: [[{ text: '⚔️ JOIN BATTLE', url: this.link(battle.id) }]] }
    });
    this.engine.store.db.prepare('UPDATE battles SET message_id=? WHERE id=?').run(sent.message_id, battle.id);
  }
  async result(battle: Battle) {
    const paid = this.engine.store.paidBattle(battle.id);
    const players = this.engine.store.players(battle.id);
    const winners = players.filter(p => p.prediction && p.prediction === battle.outcome).map(p => p.name);
    const pool = players.filter(p => p.ready).length * (paid?.stake_minor || battle.stake);
    const poolLabel = paid ? `${(pool / 1_000_000).toFixed(2)} test USDC` : `${pool} XP`;
    const text = battle.status === 'void'
      ? `⚠️ SOL QUICK BATTLE VOID\nAll staked ${paid ? 'test USDC' : 'XP'} was refunded.`
      : `🏆 ${battle.outcome === 'TIE' ? 'TIE' : `${battle.outcome} WINS`}\n\nSOL/USD $${battle.start_price!.toFixed(2)} → $${battle.end_price!.toFixed(2)}\n${battle.outcome === 'HOUSE' ? `${poolLabel} retained by the test house.` : battle.outcome === 'TIE' ? 'All stakes refunded.' : winners.length ? `Winners split ${poolLabel}: ${winners.join(', ')}` : 'No winning picks. All stakes refunded.'}\n\nUse Rematch in the Mini App to play again.`;
    await this.call('sendMessage', { chat_id: battle.chat_id, text,
      reply_markup: { inline_keyboard: [[{ text: 'VIEW RESULT / REMATCH', url: this.link(battle.id) }]] } });
  }
  async handle(update: Update) {
    const callback = update.callback_query;
    if (callback) {
      await this.call('answerCallbackQuery', { callback_query_id: callback.id });
      const stake = /^stake:(\d+)$/.exec(callback.data || '');
      if (stake && callback.message) await this.startBattle(callback.message, callback.from, Number(stake[1]));
      return;
    }
    const message = update.message;
    if (message?.migrate_to_chat_id) { this.engine.store.migrateChat(String(message.chat.id), String(message.migrate_to_chat_id)); return; }
    if (message?.migrate_from_chat_id) { this.engine.store.migrateChat(String(message.migrate_from_chat_id), String(message.chat.id)); return; }
    if (!message?.text?.startsWith('/')) return;
    const command = message.text.trim().split(/\s+/)[0].split('@')[0].toLowerCase();
    const chatId = String(message.chat.id);
    if (command === '/battle') {
      if (!['group', 'supergroup'].includes(message.chat.type)) {
        await this.call('sendMessage', { chat_id: chatId, text: 'Add me to a group, then use /battle there.' }); return;
      }
      const amount = message.text.trim().split(/\s+/)[1];
      if (!amount) {
        if (!await this.allowBattleRequest(chatId)) return;
        await this.call('sendMessage', { chat_id: chatId, text: 'Choose the XP stake for this room (minimum 10), or send /battle 25 for a custom stake.', reply_markup: { inline_keyboard: [[10, 50, 100, 500].map(n => ({ text: `${n} XP`, callback_data: `stake:${n}` }))] } });
      } else if (!/^\d+$/.test(amount) || Number(amount) < 10 || !Number.isSafeInteger(Number(amount))) {
        await this.call('sendMessage', { chat_id: chatId, text: 'Stake must be a whole number of at least 10 XP. Example: /battle 50' });
      } else if (message.from) await this.startBattle(message, message.from, Number(amount));
    } else if (command === '/paybattle' && message.from) {
      if (!this.payTesters.has(String(message.from.id))) { await this.call('sendMessage', { chat_id: chatId, text: 'Private devnet test only.' }); return; }
      if (!['group', 'supergroup'].includes(message.chat.type)) { await this.call('sendMessage', { chat_id: chatId, text: 'Use /paybattle in a test group.' }); return; }
      const amount = message.text.trim().split(/\s+/)[1] || '0.10';
      if (!/^\d+(?:\.\d{1,2})?$/.test(amount) || Number(amount) < 0.1) { await this.call('sendMessage', { chat_id: chatId, text: 'Use /paybattle 0.10 or a larger test-USDC amount.' }); return; }
      const existing = this.engine.store.active(chatId), battle = existing || this.engine.createPaid(chatId, Math.round(Number(amount) * 1_000_000), String(message.from.id));
      if (!existing) await this.card(battle); else await this.call('sendMessage', { chat_id: chatId, text: 'A battle is already open.', reply_markup: { inline_keyboard: [[{ text: 'JOIN BATTLE', url: this.link(battle.id) }]] } });
    } else if (command === '/cancel' && message.from) {
      const battle = this.engine.store.active(chatId);
      if (!battle || battle.status !== 'lobby') await this.call('sendMessage', { chat_id: chatId, text: 'There is no open lobby to cancel.' });
      else if (battle.creator_user_id !== String(message.from.id)) await this.call('sendMessage', { chat_id: chatId, text: 'Only the room creator can cancel this lobby.' });
      else this.engine.void(battle.id);
    } else if (command === '/leaderboard') {
      const rows = this.engine.store.leaderboard(chatId) as { name: string; xp: number; wins: number }[];
      await this.call('sendMessage', { chat_id: chatId, text: rows.length ? `🏆 GROUP LEADERBOARD\n${rows.slice(0, 10).map((r, i) => `${i + 1}. ${r.name} — ${r.xp} XP · ${r.wins} wins`).join('\n')}` : 'No battles completed yet.' });
    } else if (command === '/stats' && message.from) {
      const row = this.engine.store.stats(chatId, String(message.from.id)) as { wins: number; losses: number; ties: number; streak: number; xp: number } | undefined;
      const account = this.engine.store.ensureAccount(String(message.from.id), message.from.first_name);
      await this.call('sendMessage', { chat_id: chatId, text: row ? `${message.from.first_name}: ${row.wins}W / ${row.losses}L / ${row.ties}T · ${row.streak} streak · ${account.balance} XP balance` : `${message.from.first_name}: ${account.balance} XP balance. No predictions recorded yet.` });
    } else if (command === '/referral' && message.from) {
      if (message.chat.type !== 'private') { await this.call('sendMessage', { chat_id: chatId, text: 'Message me /referral privately to get your invite link.' }); return; }
      const account = this.engine.store.ensureAccount(String(message.from.id), message.from.first_name);
      await this.call('sendMessage', { chat_id: chatId, text: `Invite a new friend with this link. When they start the bot, you get 100 XP:\nhttps://t.me/${this.username}?start=ref_${account.referral_code}` });
    } else if (command === '/start' && message.from) {
      const code = /^ref_([a-f0-9]{16})$/.exec(message.text.trim().split(/\s+/)[1] || '')?.[1];
      const awarded = code ? this.engine.store.claimReferral(String(message.from.id), message.from.first_name, code) : false;
      this.engine.store.ensureAccount(String(message.from.id), message.from.first_name);
      await this.call('sendMessage', { chat_id: chatId, text: `${awarded ? 'Invitation accepted. ' : ''}You have 1000 starting XP. Add me to a group and send /battle to choose a stake and play.` });
    } else if (command === '/help') {
      await this.call('sendMessage', { chat_id: chatId, text: 'Add this bot to a group and send /battle to choose a stake of at least 10 XP. Battles support 2–100 players. The lobby runs for 30 seconds after the first player readies up, and unready players are excluded. Pick LONG or SHORT in the first 10 seconds of a 60-second round. Every account receives 100 XP daily at 00:00 UTC.' });
    }
  }
  async startBattle(message: TgMessage, creator: TgUser, stake: number) {
    const chatId = String(message.chat.id);
    if (!['group', 'supergroup'].includes(message.chat.type)) return;
    if (!Number.isSafeInteger(stake) || stake < 10) return;
    if (!await this.allowBattleRequest(chatId)) return;
    const previous = this.engine.store.active(chatId);
    if (!previous) {
      const account = this.engine.store.ensureAccount(String(creator.id), creator.first_name);
      if (account.balance < stake) { await this.call('sendMessage', { chat_id: chatId, text: `You need ${stake} XP to create this room. Your balance is ${account.balance} XP.` }); return; }
    }
    const battle = this.engine.create(chatId, stake, String(creator.id));
    if (!previous || !battle.message_id) await this.card(battle);
    else await this.call('sendMessage', { chat_id: chatId, text: 'A battle is already open.', reply_markup: { inline_keyboard: [[{ text: 'JOIN BATTLE', url: this.link(battle.id) }]] } });
  }
  private async allowBattleRequest(chatId: string) {
    const result = this.battleLimiter.take(chatId, 3, 60_000);
    if (result.allowed) return true;
    if (this.warningLimiter.take(chatId, 1, 10_000).allowed) {
      await this.call('sendMessage', { chat_id: chatId, text: `Too many battle requests. Try again in ${Math.ceil(result.retryAfterMs / 1000)} seconds.` });
    }
    return false;
  }
}
