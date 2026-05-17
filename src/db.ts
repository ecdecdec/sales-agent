import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

export const db = new Database(path.join(dataDir, 'businesses.sqlite'));

db.pragma('journal_mode = WAL');

// Initialize database tables
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
    status TEXT DEFAULT 'Не писали',
    url TEXT,
    last_contact_at DATETIME,
    contact_count INTEGER DEFAULT 0,
    earned INTEGER DEFAULT 0,
    is_auto_replies_stopped BOOLEAN DEFAULT 0
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
  
  INSERT OR IGNORE INTO system_state (key, value) VALUES ('is_paused', 'false');
`);

// Support schema upgrades
try {
  db.exec('ALTER TABLE businesses ADD COLUMN market_analysis JSON');
} catch (e) {}
try {
  db.exec('ALTER TABLE businesses ADD COLUMN last_contact_at DATETIME');
} catch (e) {}
try {
  db.exec('ALTER TABLE businesses ADD COLUMN contact_count INTEGER DEFAULT 0');
} catch (e) {}
try {
  db.exec('ALTER TABLE businesses ADD COLUMN earned INTEGER DEFAULT 0');
} catch (e) {}
try {
  db.exec('ALTER TABLE businesses ADD COLUMN is_auto_replies_stopped BOOLEAN DEFAULT 0');
} catch (e) {}
try {
  db.exec('ALTER TABLE messages_log ADD COLUMN is_from_us BOOLEAN DEFAULT 1');
} catch (e) {}

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
  status: string;
  url: string;
  last_contact_at: string | null;
  contact_count: number;
  earned: number;
  is_auto_replies_stopped: boolean;
}

export const dbHelpers = {
  saveBusiness: (business: Omit<BusinessRecord, 'scraped_at' | 'analyzed' | 'score' | 'problems' | 'market_analysis' | 'channel' | 'gpt_price' | 'status' | 'last_contact_at' | 'contact_count' | 'earned' | 'is_auto_replies_stopped'>) => {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO businesses (
        id, name, category, city, phone, website, has_photo, rating, reviews_count, has_description, has_hours, has_socials, url
      ) VALUES (
        @id, @name, @category, @city, @phone, @website, @has_photo, @rating, @reviews_count, @has_description, @has_hours, @has_socials, @url
      )
    `);
    
    const params = {
      ...business,
      has_photo: business.has_photo ? 1 : 0,
      has_description: business.has_description ? 1 : 0,
      has_hours: business.has_hours ? 1 : 0,
      has_socials: business.has_socials ? 1 : 0,
    };
    
    return stmt.run(params);
  },

  getUnanalyzed: (): BusinessRecord[] => {
    return db.prepare('SELECT * FROM businesses WHERE analyzed = 0 LIMIT 50').all() as BusinessRecord[];
  },

  updateAnalysis: (id: string, score: number, problems: any[], marketAnalysis: any, channel: string, gptPrice: number) => {
    const stmt = db.prepare(`
      UPDATE businesses 
      SET analyzed = 1, score = @score, problems = @problems, market_analysis = @market_analysis, channel = @channel, gpt_price = @gpt_price
      WHERE id = @id
    `);
    return stmt.run({
      id,
      score,
      problems: JSON.stringify(problems),
      market_analysis: JSON.stringify(marketAnalysis),
      channel,
      gpt_price: gptPrice
    });
  },

  getPendingMessages: (channel: string, limit: number = 5): BusinessRecord[] => {
    return db.prepare(`
      SELECT * FROM businesses 
      WHERE analyzed = 1 AND status = 'Не писали' AND channel = @channel AND score >= 51
      LIMIT @limit
    `).all({ channel, limit }) as BusinessRecord[];
  },

  updateStatus: (id: string, status: string) => {
    return db.prepare("UPDATE businesses SET status = @status WHERE id = @id").run({ id, status });
  },

  updateContacted: (id: string, status: string) => {
    return db.prepare("UPDATE businesses SET status = @status, last_contact_at = CURRENT_TIMESTAMP, contact_count = contact_count + 1 WHERE id = @id").run({ id, status });
  },
  
  stopAutoReplies: (id: string) => {
    return db.prepare("UPDATE businesses SET is_auto_replies_stopped = 1 WHERE id = @id").run({ id });
  },

  setEarned: (id: string, earned: number) => {
    return db.prepare("UPDATE businesses SET earned = @earned, status = 'Закрыт' WHERE id = @id").run({ id, earned });
  },

  logMessage: (businessId: string, channel: string, message: string, isFromUs: boolean = true) => {
    return db.prepare("INSERT INTO messages_log (business_id, channel, message, is_from_us) VALUES (@businessId, @channel, @message, @isFromUs)").run({ businessId, channel, message, isFromUs: isFromUs ? 1 : 0 });
  },

  getChatHistory: (businessId: string, limit: number = 10) => {
    return db.prepare("SELECT * FROM messages_log WHERE business_id = @businessId ORDER BY sent_at DESC LIMIT @limit").all({ businessId }).reverse();
  },

  getBusinessesForFollowUp: () => {
    return db.prepare(`
      SELECT * FROM businesses 
      WHERE status = 'Написали' 
      AND last_contact_at IS NOT NULL
      AND (
        (contact_count = 1 AND julianday('now') - julianday(last_contact_at) >= 2) OR
        (contact_count = 2 AND julianday('now') - julianday(last_contact_at) >= 2) OR
        (contact_count = 3 AND julianday('now') - julianday(last_contact_at) >= 3)
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

  getTodayWASends: (): number => {
    const row = db.prepare(`
      SELECT COUNT(*) as count FROM messages_log 
      WHERE channel = 'WhatsApp' AND is_from_us = 1 
      AND date(sent_at, 'localtime') = date('now', 'localtime')
      AND business_id IN (SELECT id FROM businesses WHERE contact_count = 1)
    `).get() as { count: number };
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

  isPaused: (): boolean => {
    const row = db.prepare("SELECT value FROM system_state WHERE key = 'is_paused'").get() as { value: string };
    return row.value === 'true';
  },

  setPaused: (paused: boolean) => {
    return db.prepare("UPDATE system_state SET value = @value WHERE key = 'is_paused'").run({ value: paused ? 'true' : 'false' });
  },
  
  getStats: () => {
    const writtenTodayWA = db.prepare("SELECT COUNT(DISTINCT business_id) as count FROM messages_log WHERE channel = 'WhatsApp' AND is_from_us = 1 AND date(sent_at, 'localtime') = date('now', 'localtime')").get() as {count: number};
    const writtenTodayTG = db.prepare("SELECT COUNT(DISTINCT business_id) as count FROM messages_log WHERE channel = 'Telegram' AND is_from_us = 1 AND date(sent_at, 'localtime') = date('now', 'localtime')").get() as {count: number};
    const replied = db.prepare("SELECT COUNT(*) as count FROM businesses WHERE status IN ('Ответили', 'Переговоры')").get() as {count: number};
    const closed = db.prepare("SELECT COUNT(*) as count FROM businesses WHERE status = 'Закрыт'").get() as {count: number};
    const earnedToday = db.prepare("SELECT SUM(earned) as sum FROM businesses WHERE status = 'Закрыт' AND date(last_contact_at, 'localtime') = date('now', 'localtime')").get() as {sum: number};
    
    return {
      writtenTodayWA: writtenTodayWA.count,
      writtenTodayTG: writtenTodayTG.count,
      replied: replied.count,
      closed: closed.count,
      earnedToday: earnedToday.sum || 0
    };
  }
};
