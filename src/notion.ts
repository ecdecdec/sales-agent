import { Client } from '@notionhq/client';
import winston from 'winston';
import { BusinessRecord } from './db';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/notion.log' }),
    new winston.transports.Console()
  ]
});

const notion = new Client({ auth: process.env.NOTION_API_KEY });
// Extract ID from URL if provided as full URL
let databaseId = process.env.NOTION_DATABASE_ID || '';
if (databaseId.includes('notion.site')) {
    const match = databaseId.match(/([a-f0-9]{32})/);
    if (match) databaseId = match[1];
}

export async function syncToNotion(business: BusinessRecord) {
  if (!databaseId || !process.env.NOTION_API_KEY) return;

  try {
    const response = await notion.databases.query({
      database_id: databaseId,
      filter: {
        property: 'Название бизнеса',
        title: { equals: business.name }
      }
    });

    const problems = business.problems ? JSON.parse(business.problems) : [];
    const multiSelectProblems = problems.map((p: any) => ({ name: p.title })).slice(0, 10);

    const properties: any = {
      'Название бизнеса': { title: [{ text: { content: business.name } }] },
      'Город': { select: { name: business.city } },
      'Категория': { select: { name: business.category } },
      'Score': { number: business.score },
      'Статус': { select: { name: business.status } },
    };

    if (business.phone) properties['Телефон'] = { phone_number: business.phone };
    if (multiSelectProblems.length > 0) properties['Проблемы'] = { multi_select: multiSelectProblems };
    if (business.channel) properties['Канал'] = { select: { name: business.channel } };
    if (business.gpt_price) properties['Предложенная цена GPT'] = { number: business.gpt_price };
    if (business.url) properties['Ссылка 2GIS'] = { url: business.url };
    if (business.earned) properties['Сумма сделки'] = { number: business.earned };
    
    if (business.status === 'Написали') {
        properties['Дата контакта'] = { date: { start: new Date().toISOString() } };
    }

    if (response.results.length > 0) {
      await notion.pages.update({ page_id: response.results[0].id, properties });
    } else {
      await notion.pages.create({ parent: { database_id: databaseId }, properties });
    }
  } catch (err: any) {
    logger.error(`Error syncing to Notion for ${business.name}: ${err.message}`);
  }
}
