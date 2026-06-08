import 'dotenv/config';
import { OpenAI } from 'openai';
import { Client } from '@notionhq/client';
import { Telegraf } from 'telegraf';

async function testAll() {
  console.log('=== ТЕСТИРОВАНИЕ ИНТЕГРАЦИЙ ===\n');

  // 1. Azure OpenAI
  try {
    console.log('1. Проверка Azure OpenAI...');
    const openai = new OpenAI({
      apiKey: process.env.AZURE_OPENAI_API_KEY,
      baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}`,
      defaultQuery: { 'api-version': process.env.AZURE_API_VERSION },
      defaultHeaders: { 'api-key': process.env.AZURE_OPENAI_API_KEY },
    });
    const response = await openai.chat.completions.create({
      model: process.env.AZURE_OPENAI_DEPLOYMENT as string,
      messages: [{ role: 'user', content: "Скажи 'Привет' очень коротко." }],
      temperature: 0.1,
    });
    console.log('✅ Azure OpenAI:', response.choices[0].message.content);
  } catch (err: any) {
    console.log('❌ Ошибка Azure OpenAI:', err.message);
  }

  console.log('\n---\n');

  // 2. Telegram Bot
  try {
    console.log('2. Проверка Telegram Bot...');
    if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN не задан');
    const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
    const me = await bot.telegram.getMe();
    console.log(`✅ Бот авторизован как @${me.username}`);
    if (process.env.TELEGRAM_MY_CHAT_ID) {
      await bot.telegram.sendMessage(process.env.TELEGRAM_MY_CHAT_ID, '🚀 Тестовое сообщение от Sales Agent!');
      console.log('✅ Тестовое сообщение отправлено');
    } else {
      console.log('⚠️ TELEGRAM_MY_CHAT_ID не задан, отправка пропущена.');
    }
  } catch (err: any) {
    console.log('❌ Ошибка Telegram Bot:', err.message);
  }

  console.log('\n---\n');

  // 3. Notion API
  try {
    console.log('3. Проверка Notion API...');
    if (!process.env.NOTION_API_KEY) throw new Error('NOTION_API_KEY не задан');
    if (!process.env.NOTION_DATABASE_ID) throw new Error('NOTION_DATABASE_ID не задан');

    const notion = new Client({ auth: process.env.NOTION_API_KEY });
    let dbId = process.env.NOTION_DATABASE_ID;
    if (dbId.includes('notion.site')) {
      const match = dbId.match(/([a-f0-9]{32})/);
      if (match) dbId = match[1];
    }
    const response = await notion.databases.retrieve({ database_id: dbId });
    console.log('✅ Notion база найдена:', (response as any).title[0]?.plain_text || 'Без названия');
  } catch (err: any) {
    console.log('❌ Ошибка Notion:', err.message);
  }

  console.log('\n=== ТЕСТИРОВАНИЕ ЗАВЕРШЕНО ===');
}

testAll().catch(console.error);
