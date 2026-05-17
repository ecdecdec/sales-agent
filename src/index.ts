import 'dotenv/config';
import cron from 'node-cron';
import winston from 'winston';

import { runScraper } from './scraper';
import { runAnalyzer } from './analyzer';
import { runWhatsAppSender, waClient, initWhatsApp } from './whatsapp';
import { runTelegramSender, initTelegram } from './telegram';
import { initBot, notifyMe } from './mybot';
import { dbHelpers } from './db';
import { generateFollowUp } from './messages';
import { syncToNotion } from './notion';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/agent.log' }),
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

async function runFollowUps() {
  if (dbHelpers.isPaused()) return;
  logger.info('Running follow-ups job');
  
  const followUps = dbHelpers.getBusinessesForFollowUp();
  for (const b of followUps) {
      if (b.is_auto_replies_stopped) continue; // Skip if they replied and we stopped
      
      const day = b.contact_count === 1 ? 2 : (b.contact_count === 2 ? 4 : 7);
      
      try {
          const msg = await generateFollowUp(b, day);
          
          if (b.channel === 'WhatsApp' && b.phone) {
             let cleanPhone = b.phone.replace(/[^0-9]/g, '');
             if (cleanPhone.startsWith('8')) cleanPhone = '7' + cleanPhone.slice(1);
             if (!cleanPhone.startsWith('7')) cleanPhone = '7' + cleanPhone;
             const waId = `${cleanPhone}@c.us`;
             
             await waClient.sendMessage(waId, msg);
          } else if (b.channel === 'Telegram') {
             // Simulated TG send
             logger.info(`[SIMULATED TG FOLLOW-UP] To ${b.name}: ${msg}`);
          }
          
          dbHelpers.logMessage(b.id, b.channel || 'Unknown', msg, true);
          
          if (day === 7) {
              dbHelpers.updateStatus(b.id, 'Холодный');
              await syncToNotion({ ...b, status: 'Холодный' });
          } else {
              dbHelpers.updateContacted(b.id, 'Написали');
          }
          
          logger.info(`Sent Day ${day} follow up to ${b.name}`);
          
          const delay = Math.floor(Math.random() * (120000 - 30000 + 1) + 30000); 
          await new Promise(r => setTimeout(r, delay));
          
      } catch (e: any) {
          logger.error(`Error sending follow up to ${b.name}: ${e.message}`);
      }
  }
}

async function main() {
  logger.info('Starting Sales Agent Platform v2.0...');

  await initBot();
  await initWhatsApp();
  await initTelegram();

  await notifyMe('🚀 Sales Agent V2 (Smart Outreach) запущен!');

  // 1. Скрапинг (ночью 2:00)
  cron.schedule('0 2 * * *', async () => {
    logger.info('Running scheduled task: Scraper');
    await runScraper();
  });

  // 2. Анализ и scoring (утром 8:00)
  cron.schedule('0 8 * * *', async () => {
    logger.info('Running scheduled task: Analyzer');
    await runAnalyzer();
  });

  // 3. Отправка первых сообщений (каждые 15 минут в часы работы)
  cron.schedule('*/15 9-20 * * *', async () => {
    logger.info('Running scheduled task: Message Senders');
    await runWhatsAppSender();
    await runTelegramSender();
  });
  
  // 4. Follow-ups (в 11:30 каждый день)
  cron.schedule('30 11 * * *', async () => {
    logger.info('Running scheduled task: Follow-ups');
    await runFollowUps();
  });

  logger.info('All cron jobs scheduled.');

  process.on('SIGINT', async () => {
    logger.info('SIGINT received. Shutting down gracefully...');
    await notifyMe('⚠️ Sales Agent останавливается...');
    process.exit(0);
  });
}

main().catch(err => {
  logger.error(`Fatal error in main: ${err.message}`);
  process.exit(1);
});
