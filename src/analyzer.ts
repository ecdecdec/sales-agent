import 'dotenv/config';
import { OpenAI } from 'openai';
import { dbHelpers, BusinessRecord, normalizePhone } from './db';
import { createLogger } from './logger';

const logger = createLogger('analyzer');

const openai = new OpenAI({
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}`,
  defaultQuery: { 'api-version': process.env.AZURE_API_VERSION },
  defaultHeaders: { 'api-key': process.env.AZURE_OPENAI_API_KEY },
});

const DAILY_GPT_BUDGET_USD = parseFloat(process.env.DAILY_GPT_BUDGET_USD || '5.0');
const MODEL = process.env.AZURE_OPENAI_DEPLOYMENT as string;

// ============================================================
// v4 PRICE MATRIX — hardcoded, no GPT required
// ============================================================

type CategoryKey = 'стоматология' | 'юристы' | 'автосервис' | 'строители' | 'default';

const PRICES: Record<string, Partial<Record<CategoryKey, string>>> = {
  'реактивация базы': {
    'default': 'от 40 000 тг за запуск',
  },
  '2GIS оформление': {
    'default': '50-80к тенге',
  },
  'лендинг': {
    'стоматология': '250-300к тенге',
    'юристы':       '250-350к тенге',
    'автосервис':   '200-250к тенге',
    'строители':    '250-400к тенге',
    'default':      '250-300к тенге',
  },
  'редизайн сайта': {
    'default': '250-300к тенге',
  },
  'бот записи и заявок': {
    'стоматология': '200-250к тенге',
    'юристы':       '200-250к тенге',
    'автосервис':   '150-200к тенге',
    'строители':    '200-250к тенге',
    'default':      '200-250к тенге',
  },
  'стратегия сбора отзывов': {
    'default': '100-150к тенге',
  },
  'Instagram упаковка': {
    'default': '150-200к тенге',
  },
  'AI автоматизация бизнеса': {
    'default': '400-600к тенге',
  },
};

/** Map raw category string to price matrix key */
function toCategoryKey(category: string): CategoryKey {
  const c = category.toLowerCase();
  if (c.includes('стомат'))           return 'стоматология';
  if (c.includes('юрид') || c.includes('адвокат') || c.includes('нотариус')) return 'юристы';
  if (c.includes('авто') || c.includes('шиномонт') || c.includes('сто'))     return 'автосервис';
  if (c.includes('строит') || c.includes('ремонт'))                           return 'строители';
  return 'default';
}

function getPrice(offer: string, category: string): string {
  const catKey = toCategoryKey(category);
  const offerPrices = PRICES[offer];
  if (!offerPrices) return '100-200к тенге';
  return offerPrices[catKey] || offerPrices['default'] || '100-200к тенге';
}

/** Extract mid-point of price range for gpt_price storage */
function parseMidPrice(priceRange: string): number {
  const nums = priceRange.match(/\d+/g);
  if (!nums || nums.length < 2) return 150000;
  const low = parseInt(nums[0]) * 1000;
  const high = parseInt(nums[1]) * 1000;
  return Math.round((low + high) / 2);
}

// ============================================================
// v4 SCORING — pure rule-based, no GPT
// ============================================================

function calculateScore(b: BusinessRecord): number {
  let score = 0;
  if (!b.website)               score += 40;  // No website — biggest signal
  if (b.rating < 4.3)           score += 25;  // Low rating
  if (b.reviews_count < 30)     score += 20;  // Few reviews
  if (!b.has_socials)           score += 15;  // No social presence
  // 2GIS profile pain signals
  if (!b.has_photo)             score += 30;  // No photos on 2GIS
  if (!b.has_description)       score += 25;  // No description
  if (!b.has_hours)             score += 20;  // No working hours
  return score;
}

// ============================================================
// v4 OFFER WATERFALL — determines the single best offer
// ============================================================

function determineOffer(b: BusinessRecord): string {
  // SINGLE PRODUCT: client-base reactivation. All target niches (салоны, барберы,
  // стоматологии, автосервисы, кафе, фитнес...) are returning-customer businesses
  // with a phone base, so reactivation is the offer for every lead.
  return 'реактивация базы';
}

// ============================================================
// GPT — only for score >= 60, one short call for "main pain"
// ============================================================

async function getMainPain(b: BusinessRecord): Promise<string> {
  const prompt = `Бизнес: ${b.name} (${b.category}, ${b.city})
Данные: рейтинг ${b.rating}, отзывов ${b.reviews_count}, сайт: ${b.website ? 'есть' : 'нет'}, соцсети: ${b.has_socials ? 'есть' : 'нет'}

Сформулируй главную боль этого бизнеса в одном коротком предложении (максимум 15 слов). Только текст, без объяснений.`;

  const response = await openai.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_completion_tokens: 60,
    temperature: 0.3,
  });

  if (response.usage) {
    dbHelpers.logApiCost('analyzer_pain', MODEL, response.usage.prompt_tokens, response.usage.completion_tokens);
  }

  return response.choices[0].message.content?.trim() || 'Слабое онлайн-присутствие снижает поток клиентов';
}

// ============================================================
// MAIN ANALYZER LOOP
// ============================================================

export async function runAnalyzer() {
  logger.info('Starting analyzer v4 (rule-based scoring)');

  const businesses = dbHelpers.getUnanalyzed();
  if (businesses.length === 0) {
    logger.info('No new businesses to analyze');
    return;
  }

  logger.info(`Analyzing ${businesses.length} businesses...`);

  for (const business of businesses) {
    try {
      // Step 1: Rule-based score (no GPT) — always runs regardless of budget
      const score = calculateScore(business);

      // Skip low-score leads entirely
      if (score < 60) {
        logger.info(`Skipping ${business.name}: score ${score} (below 60 threshold)`);
        dbHelpers.updateAnalysis(business.id, score, [], {}, '', 0, '', '');
        continue;
      }

      // Step 2: Determine offer (no GPT)
      const offer = determineOffer(business);
      const priceRange = getPrice(offer, business.category);
      const gptPrice = parseMidPrice(priceRange);

      // Step 3: GPT only for main pain — only if budget allows, otherwise use default
      let mainPain = 'Слабое онлайн-присутствие снижает поток клиентов';
      const costSoFar = dbHelpers.getTodayApiCost();
      if (costSoFar < DAILY_GPT_BUDGET_USD) {
        try {
          mainPain = await getMainPain(business);
        } catch (e: any) {
          logger.warn(`GPT pain call failed for ${business.name}: ${e.message}. Using default.`);
        }
      }

      // Step 4: Determine channel based on score
      const hasPhone = business.phone && business.phone.trim() !== '';
      const hasTgUser = (business.website && /(?:t\.me\/|telegram\.me\/|@)[a-zA-Z0-9_]{5,32}/i.test(business.website)) ||
                        (business.url && /(?:t\.me\/|telegram\.me\/|@)[a-zA-Z0-9_]{5,32}/i.test(business.url));

      const isWADisabled = process.env.DISABLE_WHATSAPP === 'true';
      let channel = '';

      if (hasPhone || hasTgUser) {
        if (score >= 75 && !isWADisabled && hasPhone) {
          channel = 'WhatsApp';
        } else {
          channel = 'Telegram';
        }
      }

      // Store problems as an array with the main pain
      const problems = [{ title: mainPain, impact: '', solution: offer }];

      dbHelpers.updateAnalysis(
        business.id,
        score,
        problems,
        { offer, priceRange },
        channel,
        gptPrice,
        offer,
        priceRange,
      );

      logger.info(`✅ Analyzed ${business.name}: Score ${score}, Offer: ${offer} (${priceRange}), Channel: ${channel}`);

    } catch (err: any) {
      logger.error(`Error analyzing ${business.name}: ${err.message}`);
    }
  }

  logger.info('Analyzer finished');
}

if (require.main === module) {
  runAnalyzer().catch(console.error);
}
