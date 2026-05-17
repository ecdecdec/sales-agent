import { Telegraf } from 'telegraf';
import winston from 'winston';
import { dbHelpers } from './db';
import { syncToNotion } from './notion';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/mybot.log' }),
    new winston.transports.Console()
  ]
});

export const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN || '');
const myChatId = process.env.TELEGRAM_MY_CHAT_ID;
const DAILY_GOAL = 100000;

bot.use((ctx, next) => {
  if (ctx.from?.id.toString() !== myChatId) return;
  return next();
});

bot.command('start', (ctx) => {
  const isPaused = dbHelpers.isPaused();
  ctx.reply(`🤖 Sales Agent Status: ${isPaused ? '🔴 PAUSED' : '🟢 RUNNING'}\n\nКоманды:\n/stats - Статистика за сегодня\n/goal - Прогресс по цели\n/pending - Кто ждет ответа\n/cold - Кого вернуть в работу\n/pause - Пауза рассылки\n/resume - Возобновить рассылку\n/price [ID] [сумма] - Закрыть сделку на сумму`);
});

bot.command('stats', (ctx) => {
  const s = dbHelpers.getStats();
  ctx.reply(`📊 Статистика за сегодня:\nОтправлено: ${s.writtenTodayWA + s.writtenTodayTG} (WA: ${s.writtenTodayWA}, TG: ${s.writtenTodayTG})\nОтветили: ${s.replied}\nЗакрыто сделок: ${s.closed}\nЗаработано: ${s.earnedToday} тг / ${DAILY_GOAL} тг`);
});

bot.command('goal', (ctx) => {
  const s = dbHelpers.getStats();
  const pct = Math.min(100, Math.floor((s.earnedToday / DAILY_GOAL) * 100));
  const bar = '▓'.repeat(Math.floor(pct / 10)) + '░'.repeat(10 - Math.floor(pct / 10));
  ctx.reply(`🎯 Цель дня: ${DAILY_GOAL} тг\nСобрано: ${s.earnedToday} тг\n\n[${bar}] ${pct}%`);
});

bot.command('pause', (ctx) => {
  dbHelpers.setPaused(true);
  ctx.reply('🔴 Агент поставлен на паузу.');
});

bot.command('resume', (ctx) => {
  dbHelpers.setPaused(false);
  ctx.reply('🟢 Агент возобновил работу.');
});

bot.command('pending', (ctx) => {
  const pending = require('./db').db.prepare("SELECT * FROM businesses WHERE status IN ('Ответили', 'Переговоры') AND is_auto_replies_stopped = 1 LIMIT 15").all();
  if (pending.length === 0) return ctx.reply('Нет активных диалогов ожидающих вас.');
  let msg = '🔥 Ждут ответа:\n\n';
  pending.forEach((p: any) => { msg += `- ${p.name} (${p.phone || p.id})\n`; });
  ctx.reply(msg);
});

bot.command('cold', (ctx) => {
  const cold = dbHelpers.getColdBusinesses();
  if (cold.length === 0) return ctx.reply('Нет холодных контактов для возврата.');
  ctx.reply(`❄️ Холодных контактов, прошло 6 недель: ${cold.length}`);
});

bot.hears(/^\/price (.+) (\d+)$/, async (ctx) => {
  const idOrPhone = ctx.match[1];
  const amount = parseInt(ctx.match[2], 10);
  
  const b = require('./db').db.prepare("SELECT * FROM businesses WHERE phone LIKE '%' || ? || '%' OR id = ?").get(idOrPhone, idOrPhone);
  if (b) {
      dbHelpers.setEarned(b.id, amount);
      await syncToNotion({ ...b, status: 'Закрыт', earned: amount });
      
      const s = dbHelpers.getStats();
      let msg = `🔥 CLOSED: ${b.name}\nAmount: ${amount} тг\nToday total: ${s.earnedToday} тг / ${DAILY_GOAL} тг`;
      ctx.reply(msg);
      
      if (s.earnedToday >= DAILY_GOAL) {
          ctx.reply(`🎯 Daily goal reached! Total today: ${s.earnedToday} тг`);
      }
  } else {
      ctx.reply(`Бизнес не найден.`);
  }
});

export async function initBot() {
  if (!process.env.TELEGRAM_BOT_TOKEN) return;
  bot.launch();
}

export async function notifyMe(message: string) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !myChatId) return;
  try {
    await bot.telegram.sendMessage(myChatId, message);
  } catch (e) {}
}
