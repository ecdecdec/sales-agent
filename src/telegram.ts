import 'dotenv/config';
import { TelegramClient, Api } from 'telegram';
import { NewMessage, NewMessageEvent } from 'telegram/events';
import { StoreSession } from 'telegram/sessions';
// @ts-ignore
import input from 'input';
import fs from 'fs';
import path from 'path';
import { dbHelpers, normalizePhone, db, BusinessRecord } from './db';
import { generateMessage, handleReply } from './messages';
import { syncToNotion } from './notion';
import { notifyMe } from './mybot';
import { createLogger } from './logger';

const logger = createLogger('telegram');
const DAILY_GPT_BUDGET_USD = () => parseFloat(process.env.DAILY_GPT_BUDGET_USD || '5.0');

interface TgClientConfig {
  id: number;
  hash: string;
  phone: string;
  label: string;
  sessionDirName: string;
}

const clientConfigs: TgClientConfig[] = [
  {
    id: parseInt(process.env.TELEGRAM_API_ID || '0', 10),
    hash: process.env.TELEGRAM_API_HASH || '',
    phone: process.env.TELEGRAM_PHONE || '',
    label: 'telegram_1',
    sessionDirName: 'telegram-session',
  },
  {
    id: parseInt(process.env.TELEGRAM_API_ID_2 || '0', 10),
    hash: process.env.TELEGRAM_API_HASH_2 || '',
    phone: process.env.TELEGRAM_PHONE_2 || '',
    label: 'telegram_2',
    sessionDirName: 'telegram-session-2',
  },
  {
    id: parseInt(process.env.TELEGRAM_API_ID_3 || '0', 10),
    hash: process.env.TELEGRAM_API_HASH_3 || '',
    phone: process.env.TELEGRAM_PHONE_3 || '',
    label: 'telegram_3',
    sessionDirName: 'telegram-session-3',
  },
];

export interface ActiveTgClient {
  client: TelegramClient;
  label: string;
  phone: string;
}

export const activeTgClients: ActiveTgClient[] = [];

// In-memory cache of TG user ID → business ID. Populated from DB on init.
const tgUserToBusinessId = new Map<string, string>();

function getDailyLimitPerAccount(): number {
  return 70; // 70 × 3 accounts = 210/day target
}

export function getTodaySendsForAccount(tgAccount: string): number {
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM messages_log
    WHERE channel = 'Telegram' AND is_from_us = 1
    AND date(sent_at, 'localtime') = date('now', 'localtime')
    AND business_id IN (
      SELECT id FROM businesses WHERE tg_account = @tgAccount AND contact_count = 1
    )
  `).get({ tgAccount }) as { count: number };
  return row.count;
}

export const pausedUntil = new Map<string, number>();

export function pauseAccount(label: string, durationMs: number) {
  pausedUntil.set(label, Date.now() + durationMs);
  logger.warn(`Account ${label} paused for ${Math.round(durationMs / 60000)} minutes.`);
}

let lastRRIndex = 0;
export function getNextAvailableClient(cooldowns?: Map<string, number>): ActiveTgClient | null {
  if (activeTgClients.length === 0) return null;
  const limit = getDailyLimitPerAccount();

  for (let i = 0; i < activeTgClients.length; i++) {
    const idx = (lastRRIndex + i) % activeTgClients.length;
    const clientInfo = activeTgClients[idx];

    // Check if account is paused
    const pauseTime = pausedUntil.get(clientInfo.label) || 0;
    if (Date.now() < pauseTime) {
      continue;
    }

    if (cooldowns) {
       const allowedTime = cooldowns.get(clientInfo.label) || 0;
       if (Date.now() < allowedTime) continue;
    }

    const sends = getTodaySendsForAccount(clientInfo.label);
    if (sends < limit) {
      lastRRIndex = (idx + 1) % activeTgClients.length;
      return clientInfo;
    }
  }
  return null;
}

export async function initTelegram() {
  logger.info('Initializing Telegram MTProto clients...');
  
  for (const conf of clientConfigs) {
    if (!conf.id || !conf.hash || !conf.phone) {
      logger.info(`Telegram credentials for ${conf.label} not provided. Skipping.`);
      continue;
    }

    try {
      logger.info(`Starting Telegram client for ${conf.label} (${conf.phone})...`);
      const sessionDir = path.join(process.cwd(), conf.sessionDirName);
      if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

      const storeSession = new StoreSession(sessionDir);
      const client = new TelegramClient(storeSession, conf.id, conf.hash, { connectionRetries: 5 });

      await client.start({
        phoneNumber: async () => conf.phone,
        password: async () => await input.text(`Enter 2FA password for ${conf.label} (${conf.phone}) (if any): `),
        phoneCode: async () => await input.text(`Enter the verification code for ${conf.label} (${conf.phone}): `),
        onError: (err) => { logger.error(`Telegram Auth Error for ${conf.label}: ${err.message}`); },
      });

      logger.info(`Telegram client ${conf.label} connected.`);
      
      // Register event handler for incoming messages
      client.addEventHandler(
        (event) => handleIncomingTG(event, conf.label, client),
        new NewMessage({ incoming: true })
      );

      activeTgClients.push({ client, label: conf.label, phone: conf.phone });
    } catch (e: any) {
      logger.error(`Failed to initialize Telegram client ${conf.label}: ${e.message}`);
    }
  }

  // Preload TG peer map from DB
  const peers = dbHelpers.getAllTgPeers();
  for (const p of peers) tgUserToBusinessId.set(p.tg_user_id, p.business_id);
  logger.info(`Loaded ${peers.length} TG peer mappings from DB.`);
}

async function handleIncomingTG(event: NewMessageEvent, accountLabel: string, client: TelegramClient) {
  try {
    const msg = event.message;
    if (!msg || !msg.peerId || !msg.message) return;

    if (msg.peerId.className !== 'PeerUser') return;

    const senderId = (msg.peerId as any).userId?.toString();
    if (!senderId) return;

    let businessId = tgUserToBusinessId.get(senderId);
    let b = businessId ? dbHelpers.findByIdOrPhone(businessId) : undefined;

    if (!b) {
      try {
        await ensureConnected(client);
        const result = await client.invoke(
          new Api.users.GetFullUser({ id: new Api.InputUserFromMessage({
            peer: msg.peerId as any,
            msgId: msg.id,
            userId: (msg.peerId as any).userId,
          })})
        );
        const user = (result as any).users?.[0];
        if (user?.phone) {
          b = dbHelpers.findByPhone(user.phone);
        }
      } catch (e: any) {
        logger.debug?.(`Could not resolve TG user ${senderId}: ${e.message}`);
      }
    }

    if (!b) return;

    if (b.is_auto_replies_stopped) {
      logger.info(`Ignored TG message from ${b.name} (auto-replies stopped)`);
      return;
    }

    logger.info(`📩 Incoming TG message from ${b.name} to ${accountLabel}: "${msg.message.slice(0, 80)}..."`);

    dbHelpers.updateStatus(b.id, 'Переговоры');
    dbHelpers.logMessage(b.id, 'Telegram', msg.message, false);

    const history = dbHelpers.getChatHistory(b.id);
    const aiReply = await handleReply(b, history, msg.message);

    if (aiReply.action === 'stop_and_notify' || aiReply.action === 'notify_and_reply') {
      dbHelpers.stopAutoReplies(b.id);
      const closeScript =
        `Здравствуйте! Смотрите, если вернётся даже 15-20 старых клиентов, это уже окупает всё в несколько раз, агентства за такое берут 80-100к. ` +
        `У меня два варианта: запуск рассылки по вашей базе под ключ за 40 000 тг разово, или процент от того что вернувшиеся принесут (платите только с результата). ` +
        `Когда удобно запустить, на этой неделе или на следующей?`;
      const phone = b.phone ? `+${b.phone}` : '';
      await notifyMe(
        `🔥🔥 ГОРЯЧИЙ ЛИД — ЗАКРОЙ СЕЙЧАС (не тяни, иначе уйдёт!)\n\n` +
        `${b.name} (${b.city}, ${b.category})\n` +
        `${phone}  |  Telegram (${accountLabel})\n` +
        `Клиент написал: "${msg.message}"\n\n` +
        `⚠️ Бот больше НЕ пишет — теперь твой ход. Открой чат и отправь:\n\n` +
        `${closeScript}\n\n` +
        `⏰ Сделай это в течение часа, пока он тёплый. Молчит — дожми завтра, не бросай.`
      );
    }

    if (aiReply.replyText) {
      await ensureConnected(client);
      await client.sendMessage(msg.peerId as any, { message: aiReply.replyText });
      dbHelpers.logMessage(b.id, 'Telegram', aiReply.replyText, true);
      logger.info(`Replied to ${b.name} in TG via ${accountLabel}: "${aiReply.replyText.slice(0, 60)}..."`);
    }

    await syncToNotion({ ...b, status: 'Переговоры' });

  } catch (err: any) {
    logger.error(`Error handling incoming TG message on ${accountLabel}: ${err.message}`);
  }
}

function isAstanaTime(startHour: number, endHour: number): boolean {
  const hour = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Almaty', hour: 'numeric', hour12: false }).format(new Date()),
    10
  );
  return hour >= startHour && hour < endHour;
}

function extractTgUsername(urlOrWebsite: string | null): string | null {
  if (!urlOrWebsite) return null;
  // capture group around the username — match[1] gives just the username
  const match = urlOrWebsite.match(/(?:t\.me\/|telegram\.me\/|@)([a-zA-Z0-9_]{5,32})/i);
  return match ? match[1] : null;
}

async function ensureConnected(client: TelegramClient) {
  if (!client.connected) {
    logger.info('Telegram client disconnected. Reconnecting...');
    await client.connect();
  }
}

async function resolveTelegramPeer(
  client: TelegramClient,
  accountLabel: string,
  b: { name: string; website: string | null; url: string; phone: string | null; id: string }
): Promise<{ peer: any; isPhoneImported: boolean } | null> {
  const username = extractTgUsername(b.website) || extractTgUsername(b.url);
  if (username) return { peer: username, isPhoneImported: false };

  if (b.phone) {
    const cleanPhone = normalizePhone(b.phone);
    logger.info(`No TG username for ${b.name} on ${accountLabel}. Importing +${cleanPhone}...`);
    try {
      await ensureConnected(client);
      const importResult = (await client.invoke(
        new Api.contacts.ImportContacts({
          contacts: [
            new Api.InputPhoneContact({
              clientId: BigInt(Math.floor(Math.random() * 100000000)) as any,
              phone: '+' + cleanPhone,
              firstName: b.name,
              lastName: '',
            }),
          ],
        })
      )) as any;

      if (importResult.users && importResult.users.length > 0) {
        const userId = importResult.users[0].id;
        const userIdStr = userId.toString();
        tgUserToBusinessId.set(userIdStr, b.id);
        dbHelpers.saveTgPeer(userIdStr, b.id, accountLabel);
        logger.info(`Imported ${b.name} as TG contact on ${accountLabel} (User ID: ${userId})`);
        return { peer: userId, isPhoneImported: true };
      } else {
        logger.info(`+${cleanPhone} (${b.name}) not registered on Telegram.`);
      }
    } catch (importErr: any) {
      logger.error(`Failed to import contact for ${b.name} on ${accountLabel}: ${importErr.message}`);
    }
  }

  return null;
}

export async function sendTelegramFollowUp(businessId: string, message: string): Promise<boolean> {
  const b = dbHelpers.findByIdOrPhone(businessId);
  if (!b) return false;

  const targetAccountLabel = b.tg_account || 'telegram_1';
  const clientInfo = activeTgClients.find(c => c.label === targetAccountLabel) || activeTgClients[0];
  if (!clientInfo) {
    logger.warn('Cannot send TG follow-up: no active clients available');
    return false;
  }

  const resolved = await resolveTelegramPeer(clientInfo.client, clientInfo.label, b);
  if (!resolved) {
    logger.info(`Cannot follow up ${b.name} via TG — no peer found. Sending draft to admin.`);
    await notifyMe(`📝 Follow-up черновик для ${b.name}:\n${message}`);
    return false;
  }

  try {
    await ensureConnected(clientInfo.client);
    await clientInfo.client.sendMessage(resolved.peer, { message });
    logger.info(`Sent TG follow-up to ${b.name} via ${clientInfo.label}`);
    return true;
  } catch (err: any) {
    logger.error(`Failed to send TG follow-up to ${b.name} via ${clientInfo.label}: ${err.message}`);
    return false;
  }
}

export async function sendOneTelegramPending(b: BusinessRecord, clientInfo: ActiveTgClient): Promise<boolean> {
  try {
    const resolved = await resolveTelegramPeer(clientInfo.client, clientInfo.label, b);

    if (!resolved) {
      // Not on Telegram — mark and skip instantly, NO GPT call, NO cooldown, NO admin spam
      logger.info(`${b.name} has no Telegram. Marking as Черновик and skipping.`);
      dbHelpers.updateStatus(b.id, 'Черновик');
      return false; // false = no cooldown set, doesn't count against daily limit
    }

    const msgObj = await generateMessage(b);
    const msg = msgObj.text;

    await ensureConnected(clientInfo.client);
    await clientInfo.client.sendMessage(resolved.peer, { message: msg });
    logger.info(`Sent TG message to ${b.name} via ${clientInfo.label}`);

    // Update status in DB immediately
    dbHelpers.updateContacted(b.id, 'Написали');
    dbHelpers.saveTgAccount(b.id, clientInfo.label);
    dbHelpers.logMessage(b.id, 'Telegram', msg, true);

    if (resolved.isPhoneImported) {
      const peerStr = resolved.peer.toString();
      tgUserToBusinessId.set(peerStr, b.id);
      dbHelpers.saveTgPeer(peerStr, b.id, clientInfo.label);
    }

    // Sync to Notion in background
    syncToNotion({ ...b, status: 'Написали', tg_account: clientInfo.label }).catch(err => {
      logger.error(`Failed to sync sent status for ${b.name} to Notion: ${err.message}`);
    });

    return true; // Sent successfully
  } catch (err: any) {
    const m = (err.message || '').toLowerCase();
    logger.error(`Error sending TG to ${b.name} via ${clientInfo.label}: ${err.message}`);

    if (m.includes('peer_flood') || m.includes('flood_wait')) {
      // Rate-limited — put back in queue and pause account
      dbHelpers.updateStatus(b.id, 'Не писали');
      logger.warn(`Account ${clientInfo.label} received PEER_FLOOD. Pausing it for 3 hours.`);
      pauseAccount(clientInfo.label, 3 * 60 * 60 * 1000);
    } else if (m.includes('timeout') || m.includes('disconnect') || m.includes('connection') || m.includes('econn') || m.includes('network')) {
      // Transient network issue — requeue to retry later (NOT an infinite loop: only true network errors land here)
      dbHelpers.updateStatus(b.id, 'Не писали');
      logger.warn(`Transient network error for ${b.name}, requeued.`);
    } else {
      // ANY other error (invalid/blocked/not-found/privacy/deactivated/etc) → Черновик so it NEVER retries.
      // Default-to-Черновик is the catch-all that prevents infinite send loops on bad usernames.
      logger.info(`${b.name} cannot be messaged (${err.message.slice(0, 50)}). Marking as Черновик.`);
      dbHelpers.updateStatus(b.id, 'Черновик');
    }
    return false;
  }
}

