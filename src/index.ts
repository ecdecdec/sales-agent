import 'dotenv/config';
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';

import { runScraper } from './scraper';
import { runAnalyzer } from './analyzer';
import { sendOneWhatsAppPending, getClientByLabel, initWhatsApp, getNextClient, ActiveWaClient } from './whatsapp';
import { sendOneTelegramPending, initTelegram, sendTelegramFollowUp, getNextAvailableClient, ActiveTgClient } from './telegram';
import { initBot, notifyMe } from './mybot';
import { dbHelpers, normalizePhone, BusinessRecord } from './db';
import { generateFollowUp } from './messages';
import { syncToNotion } from './notion';
import { createLogger } from './logger';

const logger = createLogger('agent');

async function runFollowUps() {
  if (dbHelpers.isPaused()) return;
  logger.info('Running follow-ups job');

  const followUps = dbHelpers.getBusinessesForFollowUp();
  for (const b of followUps) {
    const day = b.contact_count === 1 ? 5 : 12;

    try {
      const msg = await generateFollowUp(b, day);

      if (b.channel === 'WhatsApp' && b.phone) {
        const cleanPhone = normalizePhone(b.phone);
        const waId = `${cleanPhone}@c.us`;
        const waFollowUpClient = getClientByLabel(b.wa_account);
        await waFollowUpClient.sendMessage(waId, msg);
      } else if (b.channel === 'Telegram') {
        const sent = await sendTelegramFollowUp(b.id, msg);
        if (!sent) {
          logger.warn(`TG follow-up for ${b.name} could not be delivered (draft sent to admin).`);
        }
      }

      dbHelpers.logMessage(b.id, b.channel || 'Unknown', msg, true);

      if (day === 12) {
        dbHelpers.updateStatus(b.id, 'Холодный');
        await syncToNotion({ ...b, status: 'Холодный' });
      } else {
        dbHelpers.updateContacted(b.id, 'Написали');
      }

      logger.info(`Sent Day ${day} follow-up to ${b.name}`);

      // Random delay 30-120 seconds between follow-ups
      const delay = Math.floor(Math.random() * (120000 - 30000 + 1) + 30000);
      await new Promise(r => setTimeout(r, delay));

    } catch (e: any) {
      logger.error(`Error sending follow-up to ${b.name}: ${e.message}`);
    }
  }
}

async function sendDailyReport() {
  const s = dbHelpers.getStats();
  const budgetUsd = parseFloat(process.env.DAILY_GPT_BUDGET_USD || '5.0');
  const totalSent = s.writtenTodayWA + s.writtenTodayTG;
  
  let msg = `📊 Итог дня:\n` +
    `Отправлено: ${totalSent} (WA: ${s.writtenTodayWA}, TG: ${s.writtenTodayTG})\n` +
    `Ответили: ${s.replied} | Закрыто: ${s.closed}\n` +
    `💰 Заработано: ${s.earnedToday} тг\n` +
    `💸 Расходы GPT: $${s.apiCostTodayUsd.toFixed(3)} / $${budgetUsd.toFixed(2)}`;

  if (totalSent < 40) {
    msg += `\n\n⚠️ Внимание! Дневная норма не выполнена. Отправлено ${totalSent} при цели от 40 сообщений. Проверьте базу лидов или готовность аккаунтов!`;
  } else {
    msg += `\n\n✅ Дневная норма (40+ сообщений) успешно выполнена!`;
  }

  await notifyMe(msg);
}

const nextClientSendAllowedTime = new Map<string, number>();
let lastSystemSendTimestamp = 0;

function getRandomDelay(minMin: number, maxMin: number): number {
  const minMs = minMin * 60000;
  const maxMs = maxMin * 60000;
  return Math.floor(Math.random() * (maxMs - minMs + 1) + minMs);
}

function isAstanaTime(startHour: number, endHour: number): boolean {
  const hour = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Almaty', hour: 'numeric', hour12: false }).format(new Date()),
    10
  );
  return hour >= startHour && hour < endHour;
}

async function coordinatedSenderLoop() {
  logger.info('Starting coordinated background sender loop...');
  
  while (true) {
    try {
      if (dbHelpers.isPaused()) {
        await new Promise(r => setTimeout(r, 30000));
        continue;
      }

      if (!isAstanaTime(8, 23) && process.env.NODE_ENV !== 'development') {
        await new Promise(r => setTimeout(r, 60000));
        continue;
      }

      // Check system-wide spacing (minimum 10 seconds between any send)
      const now = Date.now();
      const timeSinceLastSystemSend = now - lastSystemSendTimestamp;
      if (timeSinceLastSystemSend < 10000) {
        const waitMs = 10000 - timeSinceLastSystemSend;
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }

      let b: BusinessRecord | null = null;
      let channel: 'WhatsApp' | 'Telegram' | null = null;
      let clientInfo: ActiveWaClient | ActiveTgClient | null = null;

      // Try WhatsApp first
      b = dbHelpers.getPendingMessageAndMarkSending('WhatsApp');
      if (b) {
        channel = 'WhatsApp';
        clientInfo = getNextClient(nextClientSendAllowedTime);
        if (!clientInfo) {
          // No WA account available right now (initializing or on cooldown) — put lead back and retry
          dbHelpers.updateStatus(b.id, 'Не писали');
          b = null;
        }
      }

      // Try Telegram if WhatsApp didn't proceed
      if (!b) {
        b = dbHelpers.getPendingMessageAndMarkSending('Telegram');
        if (b) {
          channel = 'Telegram';
          clientInfo = getNextAvailableClient(nextClientSendAllowedTime);
          if (!clientInfo) {
            dbHelpers.updateStatus(b.id, 'Не писали');
            b = null;
          }
        }
      }

      if (b && channel && clientInfo) {
        logger.info(`Coordinated send: Found lead "${b.name}" for ${channel} via ${clientInfo.label}`);
        
        let sent = false;
        if (channel === 'WhatsApp') {
          sent = await sendOneWhatsAppPending(b, clientInfo as ActiveWaClient);
          if (sent) {
            const delay = getRandomDelay(10, 20);
            nextClientSendAllowedTime.set(clientInfo.label, Date.now() + delay);
            lastSystemSendTimestamp = Date.now();
            logger.info(`WA message sent. ${clientInfo.label} cooldown set for ${Math.round(delay / 60000)} min.`);
          }
        } else {
          sent = await sendOneTelegramPending(b, clientInfo as ActiveTgClient);
          if (sent) {
            const delay = getRandomDelay(0.5, 1.5);
            nextClientSendAllowedTime.set(clientInfo.label, Date.now() + delay);
            lastSystemSendTimestamp = Date.now();
            logger.info(`TG message sent. ${clientInfo.label} cooldown set for ${Math.round(delay / 60000)} min.`);
          }
        }
      } else {
        await new Promise(r => setTimeout(r, 30000));
      }
    } catch (e: any) {
      logger.error(`Error in coordinated sender loop: ${e.message}`);
      await new Promise(r => setTimeout(r, 30000));
    }
  }
}

function checkSingleInstance() {
  const lockFile = path.join(process.cwd(), 'data', 'app.lock');
  const lockDir = path.dirname(lockFile);
  if (!fs.existsSync(lockDir)) {
    fs.mkdirSync(lockDir, { recursive: true });
  }

  if (fs.existsSync(lockFile)) {
    try {
      const pidStr = fs.readFileSync(lockFile, 'utf8').trim();
      const pid = parseInt(pidStr, 10);
      if (!isNaN(pid)) {
        // Check if process is still running
        process.kill(pid, 0);
        logger.error(`Another instance of Sales Agent is already running with PID ${pid}. Exiting.`);
        process.exit(1);
      }
    } catch (e: any) {
      if (e.code !== 'ESRCH') {
        logger.error(`Failed to verify lock file: ${e.message}`);
        process.exit(1);
      }
    }
  }

  fs.writeFileSync(lockFile, process.pid.toString(), 'utf8');

  const cleanup = () => {
    try {
      if (fs.existsSync(lockFile)) {
        const pidStr = fs.readFileSync(lockFile, 'utf8').trim();
        if (parseInt(pidStr, 10) === process.pid) {
          fs.unlinkSync(lockFile);
        }
      }
    } catch (e) {}
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('uncaughtException', (err) => {
    logger.error(`Uncaught exception: ${err.message}`);
    cleanup();
    process.exit(1);
  });
}

async function main() {
  checkSingleInstance();
  
  logger.info('Starting Sales Agent Platform v4.0...');
  
  // Reset any stuck sending statuses on startup
  dbHelpers.resetSendingStatuses();

  await initBot();

  if (process.env.DISABLE_WHATSAPP !== 'true') {
    await initWhatsApp();
  } else {
    logger.info('WhatsApp disabled via DISABLE_WHATSAPP env var.');
  }

  await initTelegram();
  await notifyMe('🚀 Sales Agent V4.0 запущен!');

  // Start coordinated background loop immediately
  coordinatedSenderLoop();

  // Startup: analyze existing unanalyzed leads immediately, don't wait for scraper
  logger.info('Starting analyzer on existing leads in background...');
  runAnalyzer().catch(err => logger.error(`Startup analyze error: ${err.message}`));

  // Scrape new leads in background, then analyze again
  logger.info('Starting scraper in background...');
  runScraper()
    .then(() => runAnalyzer())
    .catch(err => logger.error(`Startup scrape/analyze error: ${err.message}`));

  // 1. Scrape (nightly 2:00) + Analyze immediately after
  cron.schedule('0 2 * * *', async () => {
    logger.info('Cron: Scraper');
    await runScraper();
    logger.info('Cron: Analyzer (post-scrape)');
    await runAnalyzer();
  }, { scheduled: true, timezone: 'Asia/Almaty' });

  // 2. Analyze (every 3 hours during active window: 5:00, 8:00, 11:00, 14:00, 17:00 Astana time)
  cron.schedule('0 5,8,11,14,17 * * *', async () => {
    logger.info('Cron: Analyzer');
    await runAnalyzer();
  }, { scheduled: true, timezone: 'Asia/Almaty' });

  // 3. Follow-ups (daily 11:30)
  cron.schedule('30 11 * * *', async () => {
    logger.info('Cron: Follow-ups');
    await runFollowUps();
  }, { scheduled: true, timezone: 'Asia/Almaty' });

  // 4. Daily summary report (21:00)
  cron.schedule('0 21 * * *', async () => {
    logger.info('Cron: Daily report');
    await sendDailyReport();
  }, { scheduled: true, timezone: 'Asia/Almaty' });

  logger.info('All background loops and cron jobs scheduled.');

  process.on('SIGINT', async () => {
    logger.info('SIGINT received. Shutting down gracefully...');
    await notifyMe('⚠️ Sales Agent останавливается...');
    process.exit(0);
  });
}

main().catch(err => {
  logger.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
