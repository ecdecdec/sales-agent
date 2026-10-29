# sales-agent

Lead generation and outreach pipeline for small businesses in Kazakhstan. I built it to find
clients for my marketing agency: it pulls business listings from 2GIS, scores how much each
business needs marketing help, and sends a personalised first message over WhatsApp or Telegram.

Runs as a single Node.js process on a VPS, controlled from a private Telegram bot.

## How it works

```
2GIS Catalog API ──> scraper ──> SQLite ──> analyzer ──> sender loop ──> WhatsApp / Telegram
                                   │            │              │
                                   │      rule-based score     └─> follow-ups (day 5, day 12)
                                   │      + LLM for top leads
                                   └──> Notion (optional CRM view)
```

1. **Scrape** (`src/scraper.ts`) — queries the 2GIS Catalog API for 21 business categories
   (salons, barbershops, dental clinics, car services, cafes, gyms, ...) across 11 cities.
   Stores name, phone, website, rating, review count and profile completeness.
2. **Score** (`src/analyzer.ts`) — a rule-based score, no LLM involved:

   | signal | points |
   |---|---|
   | no website | 40 |
   | no photos on 2GIS | 30 |
   | rating < 4.3 | 25 |
   | no description | 25 |
   | fewer than 30 reviews | 20 |
   | no working hours | 20 |
   | no social links | 15 |

   Leads below 60 are dropped. Only leads that pass get one short LLM call
   (Azure OpenAI) to name the business's main problem, which keeps API spend low.
   Spend is logged per call and capped by `DAILY_GPT_BUDGET_USD`.
3. **Route** — score ≥ 75 with a phone number goes to WhatsApp, otherwise Telegram.
4. **Send** (`src/index.ts`, `whatsapp.ts`, `telegram.ts`) — one coordinated loop across
   several accounts, with per-account cooldowns, at least 10 s between any two sends and
   random delays. Messages are generated per lead in `messages.ts`.
5. **Follow up** — on day 5 and day 12. No reply after day 12 marks the lead as cold.

### Schedule (Asia/Almaty)

| time | job |
|---|---|
| 02:00 | scrape, then analyze new leads |
| 05:00–17:00, every 3 h | analyze |
| 11:30 | follow-ups |
| 21:00 | daily report to the owner (sent, replies, closed deals, revenue, API cost) |

### Bot commands

`/stats` `/pending` `/deals` `/cold` `/budget` `/goal` `/pause` `/resume` `/qr`

## Stack

TypeScript, Node.js, SQLite (better-sqlite3), whatsapp-web.js, GramJS, Telegraf,
OpenAI SDK (Azure), node-cron, Notion API, Docker.

## Running

```bash
cp .env.example .env   # fill in API keys and account credentials
npm install
npm run dev            # first run prints a WhatsApp QR code to scan
```

Production:

```bash
npm run build
docker compose up -d --build
```

## Layout

```
src/
  index.ts       entry point, cron jobs, sender loop
  scraper.ts     2GIS API client
  analyzer.ts    scoring, offer and channel selection
  messages.ts    first message and follow-up generation
  whatsapp.ts    WhatsApp clients (multiple accounts)
  telegram.ts    Telegram user clients (multiple accounts)
  mybot.ts       owner control bot
  db.ts          SQLite schema and queries
  notion.ts      optional sync to a Notion database
```
