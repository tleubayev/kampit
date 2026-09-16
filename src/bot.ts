import type { Engine } from './engine.ts';
import type { Battle } from './store.ts';

type TgUser = { id: number; first_name: string };
type TgMessage = { message_id: number; chat: { id: number; type: string }; from?: TgUser; text?: string };
type Update = { update_id: number; message?: TgMessage };

export class Bot {
  private token: string; private username: string; private shortName: string; private engine: Engine;
  constructor(token: string, username: string, shortName: string, engine: Engine) { this.token=token; this.username=username; this.shortName=shortName; this.engine=engine; }
  link(id: string) { return `https://t.me/${this.username}/${this.shortName}?startapp=${id}`; }
  async call(method: string, body: Record<string, unknown>) {
    const response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000)
    });
    const result = await response.json() as { ok: boolean; result?: any; description?: string };
    if (!response.ok || !result.ok) throw new Error(`Telegram ${method}: ${result.description || response.status}`);
    return result.result;
  }
  async setup(appUrl: string, secret: string) {
    await this.call('setWebhook', { url: `${appUrl.replace(/\/$/, '')}/telegram/webhook`, secret_token: secret, allowed_updates: ['message'], drop_pending_updates: false });
    await this.call('setMyCommands', { commands: [
      { command: 'battle', description: 'Start a SOL quick battle' },
      { command: 'leaderboard', description: 'Group XP leaderboard' },
      { command: 'stats', description: 'Your group stats' },
      { command: 'help', description: 'How to play' }
    ] });
  }
  async card(battle: Battle) {
    const sent = await this.call('sendMessage', {
      chat_id: battle.chat_id,
      text: '⚔️ SOL QUICK BATTLE\n\nPredict SOL/USD over 60 seconds. Join, ready up, then choose LONG or SHORT. Virtual XP only.',
      reply_markup: { inline_keyboard: [[{ text: '⚔️ JOIN BATTLE', url: this.link(battle.id) }]] }
    });
    this.engine.store.db.prepare('UPDATE battles SET message_id=? WHERE id=?').run(sent.message_id, battle.id);
  }
  async result(battle: Battle) {
    const players = this.engine.store.players(battle.id);
    const winners = players.filter(p => p.prediction && p.prediction === battle.outcome).map(p => p.name);
    const text = battle.status === 'void'
      ? '⚠️ SOL QUICK BATTLE VOID\nPrice feed was unavailable near the finish. No XP was awarded.'
      : `🏆 ${battle.outcome === 'TIE' ? 'TIE' : `${battle.outcome} WINS`}\n\nSOL/USD $${battle.start_price!.toFixed(2)} → $${battle.end_price!.toFixed(2)}\n${winners.length ? `Winners: ${winners.join(', ')} (+100 XP)` : 'No winning picks'}\n\nUse Rematch in the Mini App to play again.`;
    await this.call('sendMessage', { chat_id: battle.chat_id, text,
      reply_markup: { inline_keyboard: [[{ text: 'VIEW RESULT / REMATCH', url: this.link(battle.id) }]] } });
  }
  async handle(update: Update) {
    const message = update.message;
    if (!message?.text?.startsWith('/')) return;
    const command = message.text.trim().split(/\s+/)[0].split('@')[0].toLowerCase();
    const chatId = String(message.chat.id);
    if (command === '/battle') {
      if (!['group', 'supergroup'].includes(message.chat.type)) {
        await this.call('sendMessage', { chat_id: chatId, text: 'Add me to a group, then use /battle there.' }); return;
      }
      const previous = this.engine.store.active(chatId);
      const battle = this.engine.create(chatId);
      if (!previous || !battle.message_id) await this.card(battle);
      else await this.call('sendMessage', { chat_id: chatId, text: 'A battle is already open.', reply_markup: { inline_keyboard: [[{ text: 'JOIN BATTLE', url: this.link(battle.id) }]] } });
    } else if (command === '/leaderboard') {
      const rows = this.engine.store.leaderboard(chatId) as { name: string; xp: number; wins: number }[];
      await this.call('sendMessage', { chat_id: chatId, text: rows.length ? `🏆 GROUP LEADERBOARD\n${rows.slice(0, 10).map((r, i) => `${i + 1}. ${r.name} — ${r.xp} XP · ${r.wins} wins`).join('\n')}` : 'No battles completed yet.' });
    } else if (command === '/stats' && message.from) {
      const row = this.engine.store.stats(chatId, String(message.from.id)) as { wins: number; losses: number; ties: number; streak: number; xp: number } | undefined;
      await this.call('sendMessage', { chat_id: chatId, text: row ? `${message.from.first_name}: ${row.wins}W / ${row.losses}L / ${row.ties}T · ${row.streak} streak · ${row.xp} XP` : 'No predictions recorded yet.' });
    } else if (command === '/help' || command === '/start') {
      await this.call('sendMessage', { chat_id: chatId, text: 'Add this bot to a group and send /battle. Two or more players join and ready up. Pick LONG or SHORT in the first 10 seconds of a 60-second SOL/USD round. Winners get 100 virtual XP; ties give 25 XP.' });
    }
  }
}
