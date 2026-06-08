import Database, { Database as DbType } from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

export const db: DbType = new Database(path.join(dataDir, 'businesses.sqlite'));

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS businesses (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT,
    city TEXT,
    phone TEXT,
    website TEXT,
    has_photo BOOLEAN,
    rating REAL,
    reviews_count INTEGER,
    has_description BOOLEAN,
    has_hours BOOLEAN,
    has_socials BOOLEAN,
    scraped_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    analyzed INTEGER DEFAULT 0,
    score INTEGER DEFAULT 0,
    problems JSON,
    market_analysis JSON,
    channel TEXT,
    gpt_price INTEGER,
    offer TEXT,
    price_range TEXT,
    status TEXT DEFAULT 'Не писали',
    url TEXT,
    last_contact_at DATETIME,
    contact_count INTEGER DEFAULT 0,
    earned INTEGER DEFAULT 0,
    is_auto_replies_stopped BOOLEAN DEFAULT 0,
    closed_at DATETIME,
    wa_account TEXT,
    tg_account TEXT
  );

  CREATE TABLE IF NOT EXISTS messages_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    message TEXT NOT NULL,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_from_us BOOLEAN DEFAULT 1,
    FOREIGN KEY (business_id) REFERENCES businesses(id)
  );

  CREATE TABLE IF NOT EXISTS system_state (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS api_costs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    module TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tg_peer_map (
    tg_user_id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    tg_account TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (business_id) REFERENCES businesses(id)
  );

  INSERT OR IGNORE INTO system_state (key, value) VALUES ('is_paused', 'false');
`);

// Schema upgrades — safe to run every boot
const migrations = [
  'ALTER TABLE businesses ADD COLUMN market_analysis JSON',
  'ALTER TABLE businesses ADD COLUMN last_contact_at DATETIME',
  'ALTER TABLE businesses ADD COLUMN contact_count INTEGER DEFAULT 0',
  'ALTER TABLE businesses ADD COLUMN earned INTEGER DEFAULT 0',
  'ALTER TABLE businesses ADD COLUMN is_auto_replies_stopped BOOLEAN DEFAULT 0',
  'ALTER TABLE businesses ADD COLUMN closed_at DATETIME',
  'ALTER TABLE messages_log ADD COLUMN is_from_us BOOLEAN DEFAULT 1',
  'ALTER TABLE businesses ADD COLUMN wa_account TEXT',
  'ALTER TABLE businesses ADD COLUMN offer TEXT',
  'ALTER TABLE businesses ADD COLUMN price_range TEXT',
  'ALTER TABLE businesses ADD COLUMN tg_account TEXT',
  'ALTER TABLE tg_peer_map ADD COLUMN tg_account TEXT',
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (_) {}
}

// Normalize KZ phone to 7XXXXXXXXXX (11 digits, no +)
export function normalizePhone(phone: string): string {
  let clean = phone.replace(/[^0-9]/g, '');
  if (clean.startsWith('8')) clean = '7' + clean.slice(1);
  if (!clean.startsWith('7')) clean = '7' + clean;
  return clean;
}

export interface BusinessRecord {
  id: string;
  name: string;
  category: string;
  city: string;
  phone: string | null;
  website: string | null;
  has_photo: boolean;
  rating: number;
  reviews_count: number;
  has_description: boolean;
  has_hours: boolean;
  has_socials: boolean;
  scraped_at: string;
  analyzed: number;
  score: number;
  problems: string;
  market_analysis: string;
  channel: string | null;
  gpt_price: number | null;
  offer: string | null;
  price_range: string | null;
  status: string;
  url: string;
  last_contact_at: string | null;
  contact_count: number;
  earned: number;
  is_auto_replies_stopped: boolean;
  closed_at: string | null;
  wa_account: string | null;
  tg_account: string | null;
}

export const dbHelpers = {
  saveBusiness: (business: Omit<BusinessRecord, 'scraped_at' | 'analyzed' | 'score' | 'problems' | 'market_analysis' | 'channel' | 'gpt_price' | 'offer' | 'price_range' | 'status' | 'last_contact_at' | 'contact_count' | 'earned' | 'is_auto_replies_stopped' | 'closed_at' | 'wa_account' | 'tg_account'>) => {
    const stmt = db.prepare(`
      INSERT INTO businesses (
        id, name, category, city, phone, website, has_photo, rating, reviews_count, has_description, has_hours, has_socials, url
      ) VALUES (
        @id, @name, @category, @city, @phone, @website, @has_photo, @rating, @reviews_count, @has_description, @has_hours, @has_socials, @url
      )
      ON CONFLICT(id) DO UPDATE SET
        website = COALESCE(excluded.website, businesses.website),
        has_hours = excluded.has_hours,
        has_socials = excluded.has_socials,
        reviews_count = excluded.reviews_count,
        rating = excluded.rating
    `);
    return stmt.run({
      ...business,
      has_photo: business.has_photo ? 1 : 0,
      has_description: business.has_description ? 1 : 0,
      has_hours: business.has_hours ? 1 : 0,
      has_socials: business.has_socials ? 1 : 0,
    });
  },

  getUnanalyzed: (): BusinessRecord[] => {
    return db.prepare('SELECT * FROM businesses WHERE analyzed = 0 LIMIT 1000').all() as BusinessRecord[];
  },

  updateAnalysis: (id: string, score: number, problems: any[], marketAnalysis: any, channel: string, gptPrice: number, offer: string, priceRange: string) => {
    return db.prepare(`
      UPDATE businesses
      SET analyzed = 1, score = @score, problems = @problems, market_analysis = @market_analysis,
          channel = @channel, gpt_price = @gpt_price, offer = @offer, price_range = @price_range
      WHERE id = @id
    `).run({
      id, score,
      problems: JSON.stringify(problems),
      market_analysis: JSON.stringify(marketAnalysis),
      channel,
      gpt_price: gptPrice,
      offer,
      price_range: priceRange,
    });
  },

  getPendingMessages: (channel: string, limit: number = 10): BusinessRecord[] => {
    return db.prepare(`
      SELECT * FROM businesses
      WHERE analyzed = 1 AND status = 'Не писали' AND channel = @channel AND score >= 60
        AND (
          (phone IS NOT NULL AND phone != '')
          OR (website LIKE '%t.me/%' OR url LIKE '%t.me/%')
        )
      ORDER BY score DESC
      LIMIT @limit
    `).all({ channel, limit }) as BusinessRecord[];
  },

  getPendingMessageAndMarkSending: (channel: string): BusinessRecord | null => {
    const selectStmt = db.prepare(`
      SELECT * FROM businesses
      WHERE analyzed = 1 AND status = 'Не писали' AND channel = @channel AND score >= 60
        AND (
          (phone IS NOT NULL AND phone != '')
          OR (website LIKE '%t.me/%' OR url LIKE '%t.me/%')
        )
      ORDER BY score DESC
      LIMIT 1
    `);
    const updateStmt = db.prepare(`
      UPDATE businesses SET status = 'Отправка' WHERE id = @id
    `);

    const tx = db.transaction(() => {
      const b = selectStmt.get({ channel }) as BusinessRecord | undefined;
      if (!b) return null;
      updateStmt.run({ id: b.id });
      return b;
    });

    return tx();
  },

  resetSendingStatuses: () => {
    return db.prepare("UPDATE businesses SET status = 'Не писали' WHERE status = 'Отправка'").run();
  },

  updateStatus: (id: string, status: string) => {
    return db.prepare('UPDATE businesses SET status = @status WHERE id = @id').run({ id, status });
  },

  updateContacted: (id: string, status: string) => {
    return db.prepare('UPDATE businesses SET status = @status, last_contact_at = CURRENT_TIMESTAMP, contact_count = contact_count + 1 WHERE id = @id').run({ id, status });
  },

  saveWaAccount: (id: string, waAccount: string) => {
    return db.prepare('UPDATE businesses SET wa_account = @waAccount WHERE id = @id').run({ id, waAccount });
  },

  saveTgAccount: (id: string, tgAccount: string) => {
    return db.prepare('UPDATE businesses SET tg_account = @tgAccount WHERE id = @id').run({ id, tgAccount });
  },

  stopAutoReplies: (id: string) => {
    return db.prepare('UPDATE businesses SET is_auto_replies_stopped = 1 WHERE id = @id').run({ id });
  },

  setEarned: (id: string, earned: number) => {
    return db.prepare("UPDATE businesses SET earned = @earned, status = 'Закрыт', closed_at = CURRENT_TIMESTAMP WHERE id = @id").run({ id, earned });
  },

  logMessage: (businessId: string, channel: string, message: string, isFromUs: boolean = true) => {
    return db.prepare('INSERT INTO messages_log (business_id, channel, message, is_from_us) VALUES (@businessId, @channel, @message, @isFromUs)').run({ businessId, channel, message, isFromUs: isFromUs ? 1 : 0 });
  },

  getChatHistory: (businessId: string, limit: number = 10) => {
    return db.prepare('SELECT * FROM messages_log WHERE business_id = @businessId ORDER BY sent_at DESC LIMIT @limit').all({ businessId, limit }).reverse();
  },

  getBusinessesForFollowUp: () => {
    // v4 cadence: Day 0 (initial) → Day 5 (FU#1) → Day 12 (FU#2, exit)
    return db.prepare(`
      SELECT * FROM businesses
      WHERE status = 'Написали'
      AND is_auto_replies_stopped = 0
      AND last_contact_at IS NOT NULL
      AND (
        (contact_count = 1 AND julianday('now') - julianday(last_contact_at) >= 5) OR
        (contact_count = 2 AND julianday('now') - julianday(last_contact_at) >= 7)
      )
    `).all() as BusinessRecord[];
  },

  getColdBusinesses: () => {
    return db.prepare(`
      SELECT * FROM businesses
      WHERE status = 'Холодный'
      AND julianday('now') - julianday(last_contact_at) >= 42
    `).all() as BusinessRecord[];
  },

  findByPhone: (rawPhone: string): BusinessRecord | undefined => {
    const last10 = rawPhone.slice(-10);
    return db.prepare("SELECT * FROM businesses WHERE phone LIKE '%' || @last10 || '%' LIMIT 1").get({ last10 }) as BusinessRecord | undefined;
  },

  findByIdOrPhone: (idOrPhone: string): BusinessRecord | undefined => {
    return db.prepare("SELECT * FROM businesses WHERE id = @id OR phone LIKE '%' || @phone || '%' LIMIT 1").get({ id: idOrPhone, phone: idOrPhone }) as BusinessRecord | undefined;
  },

  findByStatus: (statuses: string[]): BusinessRecord[] => {
    const placeholders = statuses.map(() => '?').join(', ');
    return db.prepare(`SELECT * FROM businesses WHERE status IN (${placeholders}) AND is_auto_replies_stopped = 1 LIMIT 15`).all(...statuses) as BusinessRecord[];
  },

  saveTgPeer: (tgUserId: string, businessId: string, tgAccount?: string) => {
    return db.prepare(`
      INSERT INTO tg_peer_map (tg_user_id, business_id, tg_account, updated_at)
      VALUES (@tgUserId, @businessId, @tgAccount, CURRENT_TIMESTAMP)
      ON CONFLICT(tg_user_id) DO UPDATE SET business_id = @businessId, tg_account = @tgAccount, updated_at = CURRENT_TIMESTAMP
    `).run({ tgUserId, businessId, tgAccount: tgAccount ?? null });
  },

  getAllTgPeers: (): { tg_user_id: string; business_id: string; tg_account: string | null }[] => {
    return db.prepare('SELECT tg_user_id, business_id, tg_account FROM tg_peer_map').all() as { tg_user_id: string; business_id: string; tg_account: string | null }[];
  },

  // Switch single lead from WA to Telegram (e.g. after WA send error)
  switchChannelToTelegram: (id: string) => {
    return db.prepare("UPDATE businesses SET channel = 'Telegram', status = 'Не писали' WHERE id = @id").run({ id });
  },

  // Redirect low-value WA leads to Telegram when WA is unavailable
  switchAllWAToTelegram: () => {
    return db.prepare("UPDATE businesses SET channel = 'Telegram' WHERE status = 'Не писали' AND channel = 'WhatsApp'").run();
  },

  switchLowValueWAToTelegram: () => {
    return db.prepare("UPDATE businesses SET channel = 'Telegram' WHERE status = 'Не писали' AND channel = 'WhatsApp' AND score < 80").run();
  },

  getTodayWASends: (): number => {
    const row = db.prepare(`
      SELECT COUNT(*) as count FROM messages_log
      WHERE channel = 'WhatsApp' AND is_from_us = 1
      AND date(sent_at, 'localtime') = date('now', 'localtime')
      AND business_id IN (SELECT id FROM businesses WHERE contact_count = 1)
    `).get() as { count: number };
    return row.count;
  },

  getTodayWASendsForAccount: (waAccount: string): number => {
    const row = db.prepare(`
      SELECT COUNT(*) as count FROM messages_log
      WHERE channel = 'WhatsApp' AND is_from_us = 1
      AND date(sent_at, 'localtime') = date('now', 'localtime')
      AND business_id IN (
        SELECT id FROM businesses WHERE wa_account = @waAccount AND contact_count = 1
      )
    `).get({ waAccount }) as { count: number };
    return row.count;
  },

  getTodayTGSends: (): number => {
    const row = db.prepare(`
      SELECT COUNT(*) as count FROM messages_log
      WHERE channel = 'Telegram' AND is_from_us = 1
      AND date(sent_at, 'localtime') = date('now', 'localtime')
      AND business_id IN (SELECT id FROM businesses WHERE contact_count = 1)
    `).get() as { count: number };
    return row.count;
  },

  getTodayTGSendsForAccount: (tgAccount: string): number => {
    const row = db.prepare(`
      SELECT COUNT(*) as count FROM messages_log
      WHERE channel = 'Telegram' AND is_from_us = 1
      AND date(sent_at, 'localtime') = date('now', 'localtime')
      AND business_id IN (
        SELECT id FROM businesses WHERE tg_account = @tgAccount AND contact_count = 1
      )
    `).get({ tgAccount }) as { count: number };
    return row.count;
  },

  isPaused: (): boolean => {
    const row = db.prepare("SELECT value FROM system_state WHERE key = 'is_paused'").get() as { value: string };
    return row.value === 'true';
  },

  setPaused: (paused: boolean) => {
    return db.prepare("UPDATE system_state SET value = @value WHERE key = 'is_paused'").run({ value: paused ? 'true' : 'false' });
  },

  logApiCost: (module: string, model: string, inputTokens: number, outputTokens: number) => {
    const INPUT_COST_PER_1K = 0.005;
    const OUTPUT_COST_PER_1K = 0.015;
    const cost = (inputTokens / 1000) * INPUT_COST_PER_1K + (outputTokens / 1000) * OUTPUT_COST_PER_1K;
    const date = new Date().toISOString().slice(0, 10);
    return db.prepare('INSERT INTO api_costs (date, module, model, input_tokens, output_tokens, cost_usd) VALUES (@date, @module, @model, @inputTokens, @outputTokens, @cost)').run({ date, module, model, inputTokens, outputTokens, cost });
  },

  getTodayApiCost: (): number => {
    const date = new Date().toISOString().slice(0, 10);
    const row = db.prepare('SELECT SUM(cost_usd) as total FROM api_costs WHERE date = @date').get({ date }) as { total: number | null };
    return row.total || 0;
  },

  getStats: () => {
    const writtenTodayWA = db.prepare("SELECT COUNT(DISTINCT business_id) as count FROM messages_log WHERE channel = 'WhatsApp' AND is_from_us = 1 AND date(sent_at, 'localtime') = date('now', 'localtime')").get() as { count: number };
    const writtenTodayTG = db.prepare("SELECT COUNT(DISTINCT business_id) as count FROM messages_log WHERE channel = 'Telegram' AND is_from_us = 1 AND date(sent_at, 'localtime') = date('now', 'localtime')").get() as { count: number };
    const replied = db.prepare("SELECT COUNT(*) as count FROM businesses WHERE status IN ('Ответили', 'Переговоры')").get() as { count: number };
    const closed = db.prepare("SELECT COUNT(*) as count FROM businesses WHERE status = 'Закрыт'").get() as { count: number };
    const earnedToday = db.prepare("SELECT COALESCE(SUM(earned), 0) as sum FROM businesses WHERE status = 'Закрыт' AND date(closed_at, 'localtime') = date('now', 'localtime')").get() as { sum: number };
    const apiCostToday = db.prepare("SELECT COALESCE(SUM(cost_usd), 0) as sum FROM api_costs WHERE date = @date").get({ date: new Date().toISOString().slice(0, 10) }) as { sum: number };

    return {
      writtenTodayWA: writtenTodayWA.count,
      writtenTodayTG: writtenTodayTG.count,
      replied: replied.count,
      closed: closed.count,
      earnedToday: earnedToday.sum || 0,
      apiCostTodayUsd: apiCostToday.sum || 0,
    };
  },
};
