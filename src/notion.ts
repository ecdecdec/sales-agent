import { Client } from '@notionhq/client';
import { BusinessRecord } from './db';
import { createLogger } from './logger';

const logger = createLogger('notion');

const notion = new Client({ auth: process.env.NOTION_API_KEY });

let databaseId = process.env.NOTION_DATABASE_ID || '';
if (databaseId.includes('notion.site')) {
  const match = databaseId.match(/([a-f0-9]{32})/);
  if (match) databaseId = match[1];
}

async function withRetry<T>(fn: () => Promise<T>, context: string, retries = 3): Promise<T> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      if (attempt === retries) throw err;
      const delay = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
      logger.warn(`${context}: attempt ${attempt} failed (${err.message}). Retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('unreachable');
}

export async function syncToNotion(business: BusinessRecord) {
  if (process.env.DISABLE_NOTION === 'true') return;
  if (!databaseId || !process.env.NOTION_API_KEY) return;

  try {
    await withRetry(async () => {
      const response = await notion.databases.query({
        database_id: databaseId,
        filter: {
          property: 'Название бизнеса',
          title: { equals: business.name },
        },
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
      if (business.url) properties['Ссылка Яндекс.Карты'] = { url: business.url };
      if (business.earned) properties['Сумма сделки'] = { number: business.earned };
      if (business.status === 'Написали') {
        properties['Дата контакта'] = { date: { start: new Date().toISOString() } };
      }
      if (business.status === 'Закрыт' && business.closed_at) {
        properties['Дата закрытия'] = { date: { start: business.closed_at } };
      }

      if (response.results.length > 0) {
        await notion.pages.update({ page_id: response.results[0].id, properties });
      } else {
        await notion.pages.create({ parent: { database_id: databaseId }, properties });
      }
    }, `syncToNotion(${business.name})`);
  } catch (err: any) {
    logger.error(`Failed to sync ${business.name} to Notion after all retries: ${err.message}`);
  }
}
