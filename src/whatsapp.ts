import { Client, LocalAuth } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { dbHelpers, normalizePhone, BusinessRecord } from './db';
import { generateMessage, handleReply } from './messages';
import { notifyMe, notifyWaDisconnected } from './mybot';
import { syncToNotion } from './notion';
import { createLogger } from './logger';

const logger = createLogger('whatsapp');
const DAILY_GPT_BUDGET_USD = () => parseFloat(process.env.DAILY_GPT_BUDGET_USD || '5.0');

const SESSION_PATH_1 = process.env.WHATSAPP_SESSION_PATH || './whatsapp-session';
const SESSION_PATH_2 = process.env.WHATSAPP_SESSION_PATH_2 || './whatsapp-session-2';

const PUPPETEER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',   // critical: don't use /dev/shm (too small on VPS)
  '--no-zygote',               // skip zygote process = saves ~50MB
  '--single-process',          // all in one process = saves ~150MB
  '--disable-gpu',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-translate',
  '--disable-sync',
  '--no-first-run',
  '--mute-audio',
];

const PUPPETEER_OPTS = {
  args: PUPPETEER_ARGS,
  protocolTimeout: 30000, // 30s instead of default 3min — prevents long hangs
};

export const waClient = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_PATH_1 }),
  puppeteer: PUPPETEER_OPTS,
});

export const waClient2 = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_PATH_2 }),
  puppeteer: PUPPETEER_OPTS,
});

let isReady1 = false;
let isReady2 = false;
let isInitializing = false;
let roundRobinCounter = 0;

// Latest WhatsApp QR is BUFFERED, not auto-spammed. User pulls it on demand via /qr.
let latestQr1: string | null = null;
let waDisconnectNotified = false;

export function isWaReady(): boolean { return isReady1; }
export function getLatestWaQr(): string | null { return latestQr1; }

/** Force a fresh QR if none is buffered (e.g. after a full logout). Safe to call repeatedly. */
export async function regenerateWaQr(): Promise<void> {
  try {
    await waClient.initialize();
  } catch (e: any) {
    logger.warn(`regenerateWaQr: ${e.message}`);
  }
}

// --- QR + READY for Client 1 ---
waClient.on('qr', (qr) => {
  // Buffer the QR silently. No auto-send — the user fetches it with /qr when ready to scan.
  latestQr1 = qr;
  logger.info('📱 WhatsApp #1 QR refreshed (buffered — send /qr in Telegram to fetch).');
});
waClient.on('ready', () => {
  logger.info('✅ WhatsApp #1 is READY');
  isReady1 = true;
  latestQr1 = null;
  waDisconnectNotified = false;
  notifyMe('✅ WhatsApp подключён и готов к работе!').catch(() => {});
});
waClient.on('disconnected', (reason) => {
  logger.warn(`WhatsApp #1 disconnected: ${reason}`);
  isReady1 = false;
  // Notify ONCE with a button (not every QR tick).
  if (!waDisconnectNotified) {
    waDisconnectNotified = true;
    notifyWaDisconnected().catch(() => {});
  }
  // Re-init shortly so a fresh QR gets buffered for the next /qr.
  setTimeout(() => { waClient.initialize().catch(() => {}); }, 3000);
});

// --- QR + READY for Client 2 ---
waClient2.on('qr', (qr) => {
  if (process.env.SINGLE_WHATSAPP === 'true') return;
  logger.info('📱 WhatsApp #2 — QR CODE (scan with your SECOND phone):');
  qrcode.generate(qr, { small: true });
});
waClient2.on('ready', () => {
  logger.info('✅ WhatsApp #2 is READY');
  isReady2 = true;
});
waClient2.on('disconnected', (reason) => {
  logger.warn(`WhatsApp #2 disconnected: ${reason}`);
  isReady2 = false;
  notifyMe('⚠️ WhatsApp #2 отключился!');
});

export function isWhatsAppClientReady(label: string): boolean {
  if (label === 'WA#1') return isReady1;
  if (label === 'WA#2') return isReady2;
  return false;
}

// --- Incoming message handler (both clients) ---
function setupIncomingHandler(client: Client, label: string) {
  client.on('message', async (msg) => {
    if (msg.from === 'status@broadcast') return;
    if (dbHelpers.isPaused()) return;

    const rawPhone = msg.from.split('@')[0];
    try {
      const b = dbHelpers.findByPhone(rawPhone);
      if (!b) return;

      if (b.is_auto_replies_stopped) {
        logger.info(`Ignored WA message from ${b.name} on ${label} (auto-replies stopped)`);
        return;
      }

      logger.info(`📩 Incoming WA (${label}) from ${b.name}: "${msg.body.slice(0, 80)}..."`);

      dbHelpers.updateStatus(b.id, 'Переговоры');
      dbHelpers.logMessage(b.id, 'WhatsApp', msg.body, false);

      const history = dbHelpers.getChatHistory(b.id);
      const aiReply = await handleReply(b, history, msg.body);

      if (aiReply.action === 'stop_and_notify' || aiReply.action === 'notify_and_reply') {
        dbHelpers.stopAutoReplies(b.id);
        const closeScript =
          `Здравствуйте! Смотрите, если вернётся даже 15-20 старых клиентов, это уже окупает всё в несколько раз, агентства за такое берут 80-100к. ` +
          `У меня два варианта: запуск рассылки по вашей базе под ключ за 40 000 тг разово, или процент от того что вернувшиеся принесут (платите только с результата). ` +
          `Когда удобно запустить, на этой неделе или на следующей?`;
        const waPhone = b.phone ? `+${b.phone}` : '';
        await notifyMe(
          `🔥🔥 ГОРЯЧИЙ ЛИД — ЗАКРОЙ СЕЙЧАС (не тяни, иначе уйдёт!)\n\n` +
          `${b.name} (${b.city}, ${b.category})\n` +
          `${waPhone}  |  WhatsApp (${label})\n` +
          `Клиент написал: "${msg.body}"\n\n` +
          `⚠️ Бот больше НЕ пишет — теперь твой ход. Открой чат и отправь:\n\n` +
          `${closeScript}\n\n` +
          `⏰ Сделай это в течение часа, пока он тёплый. Молчит — дожми завтра, не бросай.`
        );
      }

      if (aiReply.replyText) {
        const delayMs = (120 + Math.floor(Math.random() * 61)) * 1000; // 2-3 min random delay
        logger.info(`⏳ Waiting ${Math.round(delayMs / 1000)}s before replying to ${b.name}...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        await client.sendMessage(msg.from, aiReply.replyText);
        dbHelpers.logMessage(b.id, 'WhatsApp', aiReply.replyText, true);
      }

      await syncToNotion({ ...b, status: 'Переговоры' });

    } catch (e: any) {
      logger.error(`Error handling incoming WA (${label}): ${e.message}`);
    }
  });
}

setupIncomingHandler(waClient, 'WA#1');
setupIncomingHandler(waClient2, 'WA#2');

export function getClientByLabel(label: string | null): Client {
  if (label === 'WA#2' && isReady2) return waClient2;
  return waClient; // default to #1
}

export interface ActiveWaClient {
  client: Client;
  label: string;
}

export function getNextClient(cooldowns?: Map<string, number>): ActiveWaClient | null {
  const clients = [
    { client: waClient, ready: isReady1, label: 'WA#1' },
  ];
  if (process.env.SINGLE_WHATSAPP !== 'true') {
    clients.push({ client: waClient2, ready: isReady2, label: 'WA#2' });
  }

  const limit = 60; // 60 messages/day per account in v4

  for (let i = 0; i < clients.length; i++) {
    const idx = (roundRobinCounter + i) % clients.length;
    const clientInfo = clients[idx];
    if (clientInfo.ready) {
      if (cooldowns) {
         const allowedTime = cooldowns.get(clientInfo.label) || 0;
         if (Date.now() < allowedTime) continue;
      }
      const sends = dbHelpers.getTodayWASendsForAccount(clientInfo.label);
      if (sends < limit) {
        roundRobinCounter = (idx + 1) % clients.length;
        return { client: clientInfo.client, label: clientInfo.label };
      }
    }
  }
  return null;
}

export async function initWhatsApp() {
  if (isInitializing) {
    logger.info('WhatsApp initialization already in progress, skipping duplicate call.');
    return;
  }
  isInitializing = true;
  const isSingle = process.env.SINGLE_WHATSAPP === 'true';
  logger.info(`Initializing WhatsApp clients (${isSingle ? 'single mode' : 'dual mode'})...`);

  const p1 = waClient.initialize().catch(e => {
    logger.error(`WhatsApp #1 init failed: ${e.message}`);
  });
  
  let p2 = Promise.resolve();
  if (!isSingle) {
    p2 = waClient2.initialize().catch(e => {
      logger.warn(`WhatsApp #2 init failed (optional): ${e.message}`);
    });
  }

  await Promise.all([p1, p2]);
}

function isAstanaTime(startHour: number, endHour: number): boolean {
  const hour = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Almaty', hour: 'numeric', hour12: false }).format(new Date()),
    10
  );
  return hour >= startHour && hour < endHour;
}
export async function sendOneWhatsAppPending(b: BusinessRecord, activeClient: ActiveWaClient): Promise<boolean> {
  if (!b.phone) {
    dbHelpers.updateStatus(b.id, 'Отказ');
    return false;
  }

  try {
    const cleanPhone = normalizePhone(b.phone);
    const waId = `${cleanPhone}@c.us`;

    const isRegistered = await activeClient.client.isRegisteredUser(waId);
    if (!isRegistered) {
      logger.info(`${b.name} (+${cleanPhone}) not on WhatsApp. Status → Отказ.`);
      dbHelpers.updateStatus(b.id, 'Отказ');
      return false; // Skip delay since we didn't send a message
    }

    const msgObj = await generateMessage(b);
    const msg = msgObj.text;

    await activeClient.client.sendMessage(waId, msg);
    logger.info(`✅ Sent WA via ${activeClient.label} to ${b.name}`);

    // Update status in DB immediately
    dbHelpers.updateContacted(b.id, 'Написали');
    dbHelpers.saveWaAccount(b.id, activeClient.label);
    dbHelpers.logMessage(b.id, 'WhatsApp', msg, true);

    // Sync to Notion in background
    syncToNotion({ ...b, status: 'Написали', wa_account: activeClient.label }).catch(err => {
      logger.error(`Failed to sync WA status for ${b.name} to Notion: ${err.message}`);
    });

    return true; // Sent successfully
  } catch (err: any) {
    logger.error(`Error sending WA to ${b.name} via ${activeClient.label}: ${err.message}`);
    // Switch to Telegram instead of re-queuing for WA — prevents infinite retry loop
    dbHelpers.switchChannelToTelegram(b.id);
    logger.info(`↩️ ${b.name} switched to Telegram after WA failure`);
    return false;
  }
}

