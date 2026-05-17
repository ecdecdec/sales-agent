import { TelegramClient } from 'telegram';
import { StoreSession } from 'telegram/sessions';
import input from 'input';
import winston from 'winston';
import fs from 'fs';
import path from 'path';
import { dbHelpers } from './db';
import { generateMessage } from './messages';
import { syncToNotion } from './notion';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/telegram.log' }),
    new winston.transports.Console()
  ]
});

// Setup Telegram MTProto Client
const apiId = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
const apiHash = process.env.TELEGRAM_API_HASH || '';
const phone = process.env.TELEGRAM_PHONE || '';

const sessionDir = path.join(process.cwd(), 'telegram-session');
if (!fs.existsSync(sessionDir)) {
  fs.mkdirSync(sessionDir, { recursive: true });
}

const storeSession = new StoreSession(sessionDir);
export const tgClient = new TelegramClient(storeSession, apiId, apiHash, {
  connectionRetries: 5,
});

export async function initTelegram() {
  if (!apiId || !apiHash || !phone) {
    logger.warn('Telegram MTProto credentials missing (TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_PHONE). Telegram sender will not work.');
    return;
  }
  
  await tgClient.start({
    phoneNumber: async () => phone,
    password: async () => await input.text('Enter your Telegram 2FA password (if any): '),
    phoneCode: async () => await input.text('Enter the Telegram code you received: '),
    onError: (err) => logger.error(`Telegram Auth Error: ${err.message}`),
  });

  logger.info('Telegram MTProto client is connected and session saved.');
}

function isAstanaTime(startHour: number, endHour: number): boolean {
  const options = { timeZone: "Asia/Almaty", hour: "numeric", hour12: false };
  const formatter = new Intl.DateTimeFormat("en-US", options);
  const hour = parseInt(formatter.format(new Date()), 10);
  return hour >= startHour && hour < endHour;
}

function extractTgUsername(urlOrWebsite: string | null): string | null {
  if (!urlOrWebsite) return null;
  const match = urlOrWebsite.match(/(?:t\.me\/|telegram\.me\/|@)([a-zA-Z0-9_]{5,32})/i);
  return match ? match[1] : null;
}

export async function runTelegramSender() {
  if (dbHelpers.isPaused()) return;
  if (!isAstanaTime(9, 20)) {
    logger.info('Outside of Telegram sending hours (9:00-20:00 Astana time)');
    return;
  }

  const TG_DAILY_LIMIT = 30;
  const sentToday = dbHelpers.getTodayTGSends();
  
  if (sentToday >= TG_DAILY_LIMIT) {
    logger.info(`Telegram daily limit (${TG_DAILY_LIMIT}) reached. Pausing Telegram sends until tomorrow.`);
    return;
  }

  const businesses = dbHelpers.getPendingMessages('Telegram', 1);
  
  for (const b of businesses) {
    if (dbHelpers.isPaused()) break;
    
    try {
      // Find username
      const username = extractTgUsername(b.website) || extractTgUsername(b.url);
      
      if (!username) {
          logger.info(`Business ${b.name} has no Telegram username. Re-routing to WhatsApp channel.`);
          require('./db').db.prepare("UPDATE businesses SET channel = 'WhatsApp' WHERE id = ?").run(b.id);
          continue; // Skip this one for now, let WA grab it
      }

      const msg = await generateMessage(b);
      
      // Delay 3-10 minutes
      const delay = Math.floor(Math.random() * (600000 - 180000 + 1) + 180000); 
      logger.info(`Waiting ${Math.floor(delay/60000)} mins before sending TG to @${username}`);
      await new Promise(r => setTimeout(r, delay));

      // Send via MTProto personal account
      await tgClient.sendMessage(username, { message: msg });
      logger.info(`Sent Telegram message to @${username} (${b.name})`);
      
      dbHelpers.logMessage(b.id, 'Telegram', msg, true);
      dbHelpers.updateContacted(b.id, 'Написали');
      await syncToNotion({ ...b, status: 'Написали' });
      
    } catch (err: any) {
      logger.error(`Error sending Telegram message to ${b.name}: ${err.message}`);
    }
  }
}
