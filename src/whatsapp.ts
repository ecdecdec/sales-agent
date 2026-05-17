import { Client, LocalAuth } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import winston from 'winston';
import { dbHelpers } from './db';
import { generateMessage, handleReply } from './messages';
import { notifyMe } from './mybot';
import { syncToNotion } from './notion';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/whatsapp.log' }),
    new winston.transports.Console()
  ]
});

export const waClient = new Client({
  authStrategy: new LocalAuth({ dataPath: process.env.WHATSAPP_SESSION_PATH }),
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

let isReady = false;

waClient.on('qr', (qr) => {
  logger.info('QR RECEIVED. Scan it with your phone.');
  qrcode.generate(qr, { small: true });
});

waClient.on('ready', () => {
  logger.info('WhatsApp Client is ready!');
  isReady = true;
});

waClient.on('message', async (msg) => {
  if (msg.from === 'status@broadcast') return;
  if (dbHelpers.isPaused()) return;
  
  const rawPhone = msg.from.split('@')[0];
  try {
    const businesses = require('./db').db.prepare("SELECT * FROM businesses WHERE phone LIKE '%' || ? || '%' AND status IN ('Написали', 'Ответили', 'Переговоры')").all(rawPhone.slice(-10));
    
    if (businesses.length > 0) {
      const b = businesses[0];
      
      if (b.is_auto_replies_stopped) {
         logger.info(`Ignored WA message from ${b.name} because auto-replies are stopped.`);
         return;
      }
      
      dbHelpers.updateStatus(b.id, 'Переговоры');
      dbHelpers.logMessage(b.id, 'WhatsApp', msg.body, false);
      
      // Get chat history
      const history = dbHelpers.getChatHistory(b.id);
      
      // AI handles reply
      const aiReply = await handleReply(b, history, msg.body);
      
      if (aiReply.action === 'stop_and_notify' || aiReply.action === 'notify_and_reply') {
         dbHelpers.stopAutoReplies(b.id);
         const notification = `💬 Ответил (WhatsApp): ${b.name} (${b.city}, ${b.category})\nTheir message: ${msg.body}\nSuggested price: ${b.gpt_price || 0} тг\nNotion: ${process.env.NOTION_DATABASE_ID}`;
         await notifyMe(notification);
      }
      
      if (aiReply.replyText && aiReply.action !== 'stop_and_notify') {
          // Send reply
          await waClient.sendMessage(msg.from, aiReply.replyText);
          dbHelpers.logMessage(b.id, 'WhatsApp', aiReply.replyText, true);
      } else if (aiReply.action === 'stop_and_notify' && aiReply.replyText) {
          // Sometimes it wants to send final goodbye before stopping
          await waClient.sendMessage(msg.from, aiReply.replyText);
          dbHelpers.logMessage(b.id, 'WhatsApp', aiReply.replyText, true);
      }
      
      await syncToNotion({ ...b, status: 'Переговоры' });
    }
  } catch (e) {
    logger.error('Error handling incoming WA message: ', e);
  }
});

export async function initWhatsApp() {
  await waClient.initialize();
}

function isAstanaTime(startHour: number, endHour: number): boolean {
  const options = { timeZone: "Asia/Almaty", hour: "numeric", hour12: false };
  const formatter = new Intl.DateTimeFormat("en-US", options);
  const hour = parseInt(formatter.format(new Date()), 10);
  return hour >= startHour && hour < endHour;
}

export async function runWhatsAppSender() {
  if (!isReady || dbHelpers.isPaused()) return;
  if (!isAstanaTime(10, 19)) {
    logger.info('Outside of WhatsApp sending hours (10:00-19:00 Astana time)');
    return;
  }

  const WA_DAILY_LIMIT = 12;
  const sentToday = dbHelpers.getTodayWASends();
  
  if (sentToday >= WA_DAILY_LIMIT) {
    logger.info(`WhatsApp daily limit (${WA_DAILY_LIMIT}) reached. Switching pending to Telegram.`);
    // Switch pending WA queue to Telegram
    require('./db').db.prepare("UPDATE businesses SET channel = 'Telegram' WHERE status = 'Не писали' AND channel = 'WhatsApp'").run();
    return;
  }

  const businesses = dbHelpers.getPendingMessages('WhatsApp', 1); // Process 1 by 1 due to long delays
  
  for (const b of businesses) {
    if (dbHelpers.isPaused()) break;
    if (!b.phone) continue;

    try {
      let cleanPhone = b.phone.replace(/[^0-9]/g, '');
      if (cleanPhone.startsWith('8')) cleanPhone = '7' + cleanPhone.slice(1);
      if (!cleanPhone.startsWith('7')) cleanPhone = '7' + cleanPhone;
      
      const waId = `${cleanPhone}@c.us`;
      
      const isRegistered = await waClient.isRegisteredUser(waId);
      if (!isRegistered) {
        dbHelpers.updateStatus(b.id, 'Отказ');
        continue;
      }

      const msg = await generateMessage(b);
      
      // Delay 20-45 minutes
      const delay = Math.floor(Math.random() * (2700000 - 1200000 + 1) + 1200000); 
      logger.info(`Waiting ${Math.floor(delay/60000)} mins before sending to ${b.name}`);
      await new Promise(r => setTimeout(r, delay));

      await waClient.sendMessage(waId, msg);
      logger.info(`Sent WA message to ${b.name}`);
      
      dbHelpers.logMessage(b.id, 'WhatsApp', msg, true);
      dbHelpers.updateContacted(b.id, 'Написали');
      await syncToNotion({ ...b, status: 'Написали' });
      
    } catch (err: any) {
      logger.error(`Error sending WA message to ${b.name}: ${err.message}`);
    }
  }
}
