import { OpenAI } from 'openai';
import { Client } from '@notionhq/client';
import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

// Load from .env.example since that's where the keys currently are
const envConfig = dotenv.parse(fs.readFileSync(path.join(__dirname, '../.env.example')));
for (const k in envConfig) {
  process.env[k] = envConfig[k];
}

async function testAll() {
  console.log("=== ТЕСТИРОВАНИЕ ИНТЕГРАЦИЙ ===\n");

  // 1. Test Azure OpenAI (GPT-5.1)
  try {
    console.log("1. Проверка Azure OpenAI (GPT-5.1)...");
    const openai = new OpenAI({
      apiKey: process.env.AZURE_OPENAI_API_KEY,
      baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}`,
      defaultQuery: { 'api-version': process.env.AZURE_API_VERSION },
      defaultHeaders: { 'api-key': process.env.AZURE_OPENAI_API_KEY },
    });

    const response = await openai.chat.completions.create({
      model: process.env.AZURE_OPENAI_DEPLOYMENT as string,
      messages: [{ role: "user", content: "Скажи 'Привет, мир!' очень коротко." }],
      temperature: 0.1,
    });
    console.log("✅ Успех: GPT-5.1 ответил:", response.choices[0].message.content);
  } catch (err: any) {
    console.log("❌ Ошибка Azure OpenAI:", err.message);
  }

  console.log("\n-------------------------\n");

  // 2. Test Telegram Bot
  try {
    console.log("2. Проверка Telegram Bot (Telegraf)...");
    const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN || '');
    const me = await bot.telegram.getMe();
    console.log(`✅ Успех: Бот авторизован как @${me.username}`);
    
    // Попробуем отправить сообщение владельцу
    if (process.env.TELEGRAM_MY_CHAT_ID) {
       await bot.telegram.sendMessage(process.env.TELEGRAM_MY_CHAT_ID, "🚀 Тестовое сообщение от Sales Agent!");
       console.log("✅ Успех: Тестовое сообщение отправлено в ваш Telegram");
    } else {
       console.log("⚠️ Chat ID не указан, отправка пропущена.");
    }
  } catch (err: any) {
    console.log("❌ Ошибка Telegram Bot:", err.message);
  }

  console.log("\n-------------------------\n");

  // 3. Test Notion API
  try {
    console.log("3. Проверка Notion API...");
    if (!process.env.NOTION_API_KEY || process.env.NOTION_API_KEY === 'your_notion_key') {
       console.log("❌ Ошибка Notion: NOTION_API_KEY не заполнен в .env.example (значение: 'your_notion_key')");
    } else {
       const notion = new Client({ auth: process.env.NOTION_API_KEY });
       let dbId = process.env.NOTION_DATABASE_ID || '';
       if (dbId.includes('notion.site')) {
           const match = dbId.match(/([a-f0-9]{32})/);
           if (match) dbId = match[1];
       }
       const response = await notion.databases.retrieve({ database_id: dbId });
       console.log("✅ Успех: Notion база данных найдена! Название:", (response as any).title[0]?.plain_text || "Без названия");
    }
  } catch (err: any) {
    console.log("❌ Ошибка Notion:", err.message);
  }

  console.log("\n=== ТЕСТИРОВАНИЕ ЗАВЕРШЕНО ===");
}

testAll().catch(console.error);
