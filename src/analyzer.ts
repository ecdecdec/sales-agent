import { OpenAI } from 'openai';
import { dbHelpers, BusinessRecord } from './db';
import winston from 'winston';
import { exec } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/analyzer.log' }),
    new winston.transports.Console()
  ]
});

// Configure Azure OpenAI
const openai = new OpenAI({
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}`,
  defaultQuery: { 'api-version': process.env.AZURE_API_VERSION },
  defaultHeaders: { 'api-key': process.env.AZURE_OPENAI_API_KEY },
});

export async function runAnalyzer() {
  logger.info('Starting GPT-5.1 analyzer');
  
  const businesses = dbHelpers.getUnanalyzed();
  if (businesses.length === 0) {
    logger.info('No new businesses to analyze');
    return;
  }
  
  logger.info(`Analyzing ${businesses.length} businesses...`);
  
  for (const business of businesses) {
    try {
      const analysisResult = await analyzeBusiness(business);
      
      let channel = null;
      if (analysisResult.score >= 75) channel = 'WhatsApp';
      else if (analysisResult.score >= 51) channel = 'Telegram';
      
      dbHelpers.updateAnalysis(
        business.id,
        analysisResult.score,
        analysisResult.problems,
        analysisResult.market_analysis,
        channel || '',
        analysisResult.gpt_price
      );
      
      logger.info(`Analyzed ${business.name}: Score ${analysisResult.score}, Channel: ${channel}`);
      
    } catch (err: any) {
      logger.error(`Error analyzing business ${business.name}: ${err.message}`);
    }
  }
  
  logger.info('Analyzer finished');
}

async function analyzeBusiness(b: BusinessRecord) {
  let websiteContext = '';
  if (b.website) {
    logger.info(`Fetching website context for ${b.website} using agent-browser...`);
    try {
      await execPromise(`npx agent-browser open ${b.website}`);
      const { stdout } = await execPromise(`npx agent-browser snapshot --max-output 3000`);
      websiteContext = `\nДанные с сайта бизнеса (получены через agent-browser):\n${stdout}\n`;
    } catch (err: any) {
      logger.warn(`Failed to fetch website context for ${b.website}: ${err.message}`);
    }
  }

  const prompt = `
Ты Senior Business Analyst и B2B Sales Strategist в Казахстане. Твоя задача - глубоко проанализировать бизнес и подготовить Market Analysis для дальнейшей отправки холодного сообщения.
Бизнес из 2GIS:
- Название: ${b.name}
- Категория: ${b.category}
- Город: ${b.city}
- Есть сайт: ${b.website ? 'Да (' + b.website + ')' : 'Нет'}
- Есть фото: ${b.has_photo ? 'Да' : 'Нет'}
- Рейтинг: ${b.rating} (Отзывов: ${b.reviews_count})
- Есть описание: ${b.has_description ? 'Да' : 'Нет'}
- Указаны часы работы: ${b.has_hours ? 'Да' : 'Нет'}
- Есть соцсети: ${b.has_socials ? 'Да' : 'Нет'}
${websiteContext}

ПРАВИЛА И СТОИМОСТЬ УСЛУГ (для расчета gpt_price):
- 2GIS профиль (оформление): 60,000-150,000 тг
- Google My Business: 80,000-180,000 тг
- Kaspi магазин: 80,000-200,000 тг
- Landing page (Tilda/Wix): 150,000-400,000 тг
- Многостраничный сайт: 300,000-800,000 тг
- Instagram (дизайн + 9 постов): 120,000-300,000 тг
- WhatsApp Business автоответы: 60,000-150,000 тг
- Telegram чатбот: 200,000-500,000 тг
- SEO оптимизация: 120,000-250,000 тг
- Онлайн-запись/бронирование: 150,000-400,000 тг
- Фото для профиля (10-20 фото, ретушь): 50,000-120,000 тг
- Электронное меню/прайс: 40,000-100,000 тг

МУЛЬТИПЛИКАТОРЫ (примени к базовой цене):
- Город Almaty/Astana: x1.5
- Крупный бизнес или сеть (судя по отзывам/сайту): x2
- Мелкий региональный бизнес: x0.7
- Если предлагаем несколько услуг вместе: скидка 15%

ВЫХОДНЫЕ ДАННЫЕ СТРОГО В JSON (без markdown):
{
  "market_analysis": {
    "what_matters_most": "Что важнее всего для клиентов этой категории в Казахстане?",
    "revenue_hurdles": "Какие реальные проблемы сейчас убивают их доход?",
    "competitors_advantage": "Что конкуренты в их городе делают лучше?",
    "realistic_price_range": "Реалистичный диапазон бюджета для них"
  },
  "problems": [
    {
      "title": "название проблемы (конкретно: нет фото, нет сайта, низкий рейтинг и тд)",
      "impact": "влияние на выручку",
      "solution": "что именно мы предложим сделать"
    }
  ],
  "score": 85, // 0-50: скипаем, 51-74: Telegram, 75-100: WhatsApp
  "gpt_price": 150000 // Итоговая рассчитанная цена (число, в тенге)
}
`;

  const response = await openai.chat.completions.create({
    model: process.env.AZURE_OPENAI_DEPLOYMENT as string,
    messages: [
      { role: "system", content: "You are an expert marketing analyzer. Always return valid JSON." },
      { role: "user", content: prompt }
    ],
    temperature: 0.3,
  });

  const content = response.choices[0].message.content?.trim();
  if (!content) throw new Error("Empty response from GPT");
  
  const cleanJson = content.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  return JSON.parse(cleanJson);
}

// Allow running directly
if (require.main === module) {
  runAnalyzer().catch(console.error);
}
