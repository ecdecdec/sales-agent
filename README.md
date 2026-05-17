# Sales Agent

Autonomous Sales Agent for the Kazakhstani market.

## Features
- Scrapes businesses from 2GIS using Playwright.
- Analyzes business profiles with GPT-5.1 to find issues (no website, poor SEO, low rating, etc.).
- Categorizes businesses and calculates a target score.
- Engages businesses via WhatsApp and Telegram using personalized messages.
- Manages state via SQLite and Notion Database.
- Controlled via a personal Telegram Bot.

## Setup

1. Copy `.env.example` to `.env` and fill in the values:
   ```bash
   cp .env.example .env
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the project:
   ```bash
   npm run build
   ```

4. First run (to scan WhatsApp QR code):
   ```bash
   npm run dev
   ```

## Deploy to DigitalOcean

1. Clone the repository on your droplet.
2. Setup `.env` file.
3. Build and run using Docker Compose:
   ```bash
   docker-compose up -d --build
   ```

## Architecture
- `scraper.ts`: Collects business data from 2GIS.
- `analyzer.ts`: Prompts GPT-5.1 to evaluate business profiles.
- `whatsapp.ts`: Handles WhatsApp Web automation.
- `telegram.ts`: Handles Telegram outreach.
- `notion.ts`: Syncs leads to Notion.
- `mybot.ts`: Command interface for the owner.
- `index.ts`: Orchestrates all jobs via cron.
