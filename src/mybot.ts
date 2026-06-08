import { Telegraf, Markup } from 'telegraf';
import { dbHelpers } from './db';
import { syncToNotion } from './notion';
import { createLogger } from './logger';
import { getLatestWaQr, isWaReady, regenerateWaQr } from './whatsapp';

const logger = createLogger('mybot');

export const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN || '');
const myChatId = process.env.TELEGRAM_MY_CHAT_ID;
const DAILY_GOAL = 100000;

bot.use((ctx, next) => {
  if (ctx.from?.id.toString() !== myChatId) return;
  return next();
});

bot.command('start', (ctx) => {
  const isPaused = dbHelpers.isPaused();
  ctx.reply(
    `🤖 Sales Agent Status: ${isPaused ? '🔴 PAUSED' : '🟢 RUNNING'}\n\n` +
    `Команды:\n` +
    `/stats — Статистика за сегодня\n` +
    `/goal — Прогресс по цели\n` +
    `/budget — Расходы на GPT сегодня\n` +
    `/deals — Активные переговоры (закрыть сделку)\n` +
    `/pending — Кто ждет ответа\n` +
    `/cold — Кого вернуть в работу\n` +
    `/pause — Пауза рассылки\n` +
    `/resume — Возобновить рассылку\n` +
    `/qr — Получить QR для подключения WhatsApp\n` +
    `/price [ID/телефон] [сумма] — Закрыть сделку на сумму`
  );
});

// --- WhatsApp QR on demand (no more auto-spam) ---
async function deliverWaQr(reply: (text: string) => Promise<any>) {
  if (isWaReady()) {
    await reply('✅ WhatsApp уже подключён, QR не нужен.');
    return;
  }
  const qr = getLatestWaQr();
  if (!qr) {
    await reply('🔄 Генерирую свежий QR, подожди ~10 секунд и снова нажми /qr.');
    regenerateWaQr().catch(() => {});
    return;
  }
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=350x350&data=${encodeURIComponent(qr)}`;
  await reply(
    `📱 WhatsApp QR.\n` +
    `Открой WhatsApp → Связанные устройства → Привязать устройство и отсканируй:\n${qrUrl}\n\n` +
    `Если код протух — нажми /qr ещё раз.`
  );
}

bot.command('qr', (ctx) => deliverWaQr((t) => ctx.reply(t)));
bot.action('wa_qr', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await deliverWaQr((t) => ctx.reply(t));
});

/** Called by whatsapp.ts on disconnect: ONE alert with a button instead of QR spam. */
export async function notifyWaDisconnected() {
  if (!process.env.TELEGRAM_BOT_TOKEN || !myChatId) return;
  try {
    await bot.telegram.sendMessage(
      myChatId,
      '⚠️ WhatsApp отключился. Когда будешь готов сканировать — нажми кнопку ниже.',
      Markup.inlineKeyboard([Markup.button.callback('🔄 Сгенерировать QR', 'wa_qr')])
    );
  } catch (e: any) {
    logger.warn(`notifyWaDisconnected failed: ${e.message}`);
  }
}

bot.command('stats', (ctx) => {
  const s = dbHelpers.getStats();
  ctx.reply(
    `📊 Статистика за сегодня:\n` +
    `Отправлено: ${s.writtenTodayWA + s.writtenTodayTG} (WA: ${s.writtenTodayWA}, TG: ${s.writtenTodayTG})\n` +
    `Ответили: ${s.replied}\n` +
    `Закрыто сделок: ${s.closed}\n` +
    `Заработано сегодня: ${s.earnedToday} тг / ${DAILY_GOAL} тг\n` +
    `Расходы GPT: $${s.apiCostTodayUsd.toFixed(3)}`
  );
});

bot.command('goal', (ctx) => {
  const s = dbHelpers.getStats();
  const pct = Math.min(100, Math.floor((s.earnedToday / DAILY_GOAL) * 100));
  const bar = '▓'.repeat(Math.floor(pct / 10)) + '░'.repeat(10 - Math.floor(pct / 10));
  ctx.reply(`🎯 Цель дня: ${DAILY_GOAL} тг\nСобрано: ${s.earnedToday} тг\n\n[${bar}] ${pct}%`);
});

bot.command('budget', (ctx) => {
  const costUsd = dbHelpers.getTodayApiCost();
  const budgetUsd = parseFloat(process.env.DAILY_GPT_BUDGET_USD || '5.0');
  const pct = Math.min(100, Math.floor((costUsd / budgetUsd) * 100));
  const bar = '▓'.repeat(Math.floor(pct / 10)) + '░'.repeat(10 - Math.floor(pct / 10));
  ctx.reply(
    `💸 Расходы на GPT сегодня:\n` +
    `$${costUsd.toFixed(3)} из $${budgetUsd.toFixed(2)} лимита\n\n` +
    `[${bar}] ${pct}%`
  );
});

bot.command('pause', (ctx) => {
  dbHelpers.setPaused(true);
  ctx.reply('🔴 Агент поставлен на паузу.');
});

bot.command('resume', (ctx) => {
  dbHelpers.setPaused(false);
  ctx.reply('🟢 Агент возобновил работу.');
});

bot.command('deals', (ctx) => {
  const deals = dbHelpers.findByStatus(['Переговоры']);
  if (deals.length === 0) return ctx.reply('Нет активных переговоров.');

  let msg = '💼 Активные переговоры:\n\n';
  deals.forEach((d) => {
    const phone = d.phone ? `+${d.phone}` : 'нет телефона';
    const channel = d.channel || '?';
    msg += `• ${d.name}\n`;
    msg += `  📍 ${d.city} | ${d.category}\n`;
    msg += `  📞 ${phone} | ${channel}\n`;
    msg += `  💰 Предложить: ~${d.gpt_price || '?'} тг\n`;
    msg += `  /price ${d.id} [СУММА]\n\n`;
  });
  ctx.reply(msg);
});

bot.command('pending', (ctx) => {
  const pending = dbHelpers.findByStatus(['Ответили', 'Переговоры']);
  if (pending.length === 0) return ctx.reply('Нет активных диалогов, ожидающих вас.');
  let msg = '🔥 Ждут ответа:\n\n';
  pending.forEach((p) => { msg += `- ${p.name} (${p.phone || p.id})\n`; });
  ctx.reply(msg);
});

bot.command('cold', (ctx) => {
  const cold = dbHelpers.getColdBusinesses();
  if (cold.length === 0) return ctx.reply('Нет холодных контактов для возврата.');
  ctx.reply(`❄️ Холодных контактов (прошло 6 недель): ${cold.length}`);
});

bot.hears(/^\/price (.+) (\d+)$/, async (ctx) => {
  const idOrPhone = ctx.match[1];
  const amount = parseInt(ctx.match[2], 10);

  const b = dbHelpers.findByIdOrPhone(idOrPhone);
  if (!b) return ctx.reply('Бизнес не найден.');

  dbHelpers.setEarned(b.id, amount);
  await syncToNotion({ ...b, status: 'Закрыт', earned: amount, closed_at: new Date().toISOString() });

  const s = dbHelpers.getStats();
  ctx.reply(`🔥 CLOSED: ${b.name}\nAmount: ${amount} тг\nToday total: ${s.earnedToday} тг / ${DAILY_GOAL} тг`);

  if (s.earnedToday >= DAILY_GOAL) {
    ctx.reply(`🎯 Daily goal reached! Total today: ${s.earnedToday} тг`);
  }
});

export async function initBot() {
  if (!process.env.TELEGRAM_BOT_TOKEN) return;
  // Launch asynchronously so it never blocks the rest of the application startup
  bot.launch().then(() => {
    logger.info('Telegram control bot launched successfully.');
  }).catch((err: any) => {
    logger.error(`Failed to launch Telegram control bot: ${err.message}. Agent will continue running without control bot.`);
  });
}

export async function notifyMe(message: string) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !myChatId) return;
  try {
    await bot.telegram.sendMessage(myChatId, message);
  } catch (e: any) {
    logger.warn(`notifyMe failed: ${e.message}`);
  }
}
