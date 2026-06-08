import { dbHelpers } from './db';
import { createLogger } from './logger';

const logger = createLogger('scraper');

// 2GIS API configuration
const API_BASE = 'https://catalog.api.2gis.com/3.0/items';
const API_KEY = 'demo'; // 2GIS demo key

// Kazakhstan cities with 2GIS region IDs
const CITIES: { name: string; region_id: number }[] = [
  { name: 'almaty', region_id: 67 },
  { name: 'astana', region_id: 68 },
  { name: 'shymkent', region_id: 111 },
  { name: 'karaganda', region_id: 84 },
  { name: 'aktobe', region_id: 91 },
  { name: 'atyrau', region_id: 155 },
  { name: 'aktau', region_id: 154 },
  { name: 'pavlodar', region_id: 152 },
  { name: 'kostanay', region_id: 153 },
  { name: 'taraz', region_id: 156 },
  { name: 'ust-kamenogorsk', region_id: 169 },
];

// v7 categories: ТОЛЬКО ниши, где клиент ищет на карте и выбирает глазами
// (фото / отзывы / рейтинг) → 2ГИС + сайт напрямую приносят деньги.
// Убраны мёртвые B2B / тендерные / по-рекомендации ниши: юристы, стройка,
// бухгалтерия, грузоперевозки, охрана, ремонт квартир, медцентры, детсады,
// турагентства, клининг, языковые школы — карта им не продаёт.
const CATEGORIES = [
  // --- Бьюти / уход (огромный объём, топ конверсия, выбор глазами) ---
  'салон красоты',
  'студия маникюра',
  'барбершоп',
  'косметологический центр',
  'спа-салон',
  'массажный салон',
  'студия наращивания ресниц',
  // --- Еда / напитки (трафик, фото и отзывы решают всё) ---
  'кофейня',
  'ресторан',
  'кафе',
  'пекарня',
  'кальянная',
  // --- Авто (локально, ищут «рядом» на карте) ---
  'автосервис',
  'автомойка',
  'шиномонтаж',
  'детейлинг',
  // --- Локальное здоровье (визуал + отзывы = доверие) ---
  'стоматология',
  'ветеринарная клиника',
  // --- Фитнес ---
  'фитнес-клуб',
  'студия йоги',
  // --- Визуал ---
  'фотостудия',
];

// Corporate keywords — skip large chains, franchises, holding companies
// Also skip brand dealerships, government, banks, franchises — 
// we only want small owner-operated businesses
const CORPORATE_KEYWORDS = /холдинг|group|сеть|филиал|корпорация|national|франчайз|franchise|официальный дилер|дилерский центр|автосалон|собственный автоцентр|поликлиника|больница|госпиталь|государственн|министерство|акимат|департамент|управление|банк|страхов|бухгалтер|аудит|нотариальная палата|нотариальная контора/i;

// Known car/corporate brands — never our clients
const BRAND_KEYWORDS = /hyundai|toyota|lexus|bmw|mercedes|audi|volkswagen|porsche|kia|nissan|honda|mazda|subaru|mitsubishi|suzuki|land rover|jaguar|volvo|peugeot|renault|citroen|opel|škoda|skoda|chevrolet|ford|geely|chery|haval|tank|exeed|omoda|jaecoo|jetour|changan|byd|li auto|zeekr|lixiang|gac|faw|dongfeng|great wall|lada|газпром|kaspi|halyk|forte|jusan|freedom|samsung|apple|huawei|xiaomi|honor|ikea|hm|h&m|zara|inditex|coca.cola|pepsi|mcdon|kfc|burger king|starbucks|subway|papa john|domino|pizza hut|allur|астана моторс|бипэк авто/i;

interface TwoGisContact {
  type: string;
  value: string;
  text?: string;
  url?: string;
}

interface TwoGisItem {
  id: string;
  name: string;
  address_name?: string;
  full_name?: string;
  type: string;
  contact_groups?: { contacts: TwoGisContact[] }[];
  reviews?: {
    general_rating?: number;
    general_review_count?: number;
    org_rating?: number;
    org_review_count?: number;
  };
}

interface TwoGisResponse {
  meta: { code: number };
  result?: {
    items: TwoGisItem[];
    total: number;
  };
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function runScraper() {
  logger.info('Starting 2GIS API scraper v5');

  try {
    for (const city of CITIES) {
      for (const category of CATEGORIES) {
        logger.info(`Scraping category "${category}" in ${city.name}`);

        try {
          let totalSaved = 0;

          // Fetch up to 5 pages
          for (let page = 1; page <= 5; page++) {
            const params = new URLSearchParams({
              q: category,
              region_id: String(city.region_id),
              key: API_KEY,
              page: String(page),
              page_size: '20',
              fields: 'items.contact_groups,items.reviews,items.purpose_name',
            });

            const url = `${API_BASE}?${params.toString()}`;
            const response = await fetch(url);
            const data = (await response.json()) as TwoGisResponse;

            if (data.meta.code !== 200 || !data.result?.items?.length) {
              logger.info(`No results on page ${page} for "${category}" in ${city.name}`);
              break;
            }

            logger.info(`Page ${page}: ${data.result.items.length} items (total: ${data.result.total})`);

            for (const item of data.result.items) {
              try {
                const name = item.name;
                if (!name) continue;

                // Skip corporate chains
                if (CORPORATE_KEYWORDS.test(name)) {
                  logger.info(`Skipping ${name}: corporate keyword in name`);
                  continue;
                }

                // Skip known brands (car dealerships, fast food, tech giants, etc.)
                if (BRAND_KEYWORDS.test(name)) {
                  logger.info(`Skipping ${name}: known brand in name`);
                  continue;
                }

                // Skip by 2GIS purpose/type (auto dealerships, government, etc.)
                const purposeName = (item as any).purpose_name || '';
                if (/автосалон|дилер|государств|муницип|полицейск|воинск/i.test(purposeName)) {
                  logger.info(`Skipping ${name}: purpose "${purposeName}" not our target`);
                  continue;
                }

                // Extract phone number
                const allContacts = (item.contact_groups || []).flatMap(g => g.contacts || []);
                const phoneContact = allContacts.find(c => c.type === 'phone');
                const phone = phoneContact?.value || null;

                // === KAZAKHSTAN PHONE FILTER ===
                if (!phone) {
                  logger.info(`Skipping ${name}: no phone number`);
                  continue;
                }
                const digits = phone.replace(/[^0-9+]/g, '');
                const isKZ = /^(\+?77|87)/.test(digits);
                if (!isKZ) {
                  logger.info(`Skipping ${name}: non-KZ phone ${phone}`);
                  continue;
                }

                // Extract reviews count and rating
                const reviewsCount = item.reviews?.org_review_count || item.reviews?.general_review_count || 0;
                const rating = item.reviews?.org_rating || item.reviews?.general_rating || 0;

                // SIZE FILTER: skip businesses with too many reviews (large chains with agencies)
                if (reviewsCount > 300) {
                  logger.info(`Skipping ${name}: ${reviewsCount} reviews (too large, likely has agency)`);
                  continue;
                }

                // Extract website (prefer t.me link over generic website so TG peer resolution works)
                const websiteContact = allContacts.find(c => c.type === 'website');
                const tgContact = allContacts.find(c => c.type === 'telegram');
                // Prefer telegram URL so extractTgUsername() can resolve it directly
                const tgUrl = tgContact?.url || tgContact?.value || null;
                const website = tgUrl || websiteContact?.value || null;

                // Check for social media presence
                const hasSocials = allContacts.some(c =>
                  ['instagram', 'vkontakte', 'whatsapp', 'telegram', 'facebook'].includes(c.type)
                );

                // Check schedule
                const hasHours = (item.contact_groups || []).some(g => (g as any).schedule);

                const id = phone || item.id;

                dbHelpers.saveBusiness({
                  id,
                  name,
                  category,
                  city: city.name,
                  phone,
                  website,
                  has_photo: false,
                  rating: Math.round(rating * 10), // Store as integer (50 = 5.0)
                  reviews_count: reviewsCount,
                  has_description: false,
                  has_hours: hasHours,
                  has_socials: hasSocials,
                  url: `https://2gis.kz/${city.name}/firm/${item.id.split('_')[0]}`,
                });

                totalSaved++;
                logger.info(`Saved: ${name} (phone: ${phone}, reviews: ${reviewsCount}, rating: ${rating})`);

              } catch (err: any) {
                logger.error(`Error processing item ${item.name}: ${err.message}`);
              }
            }

            // Respect API rate limits (small delay between pages)
            await delay(2000);
          }

          logger.info(`Saved ${totalSaved} businesses for "${category}" in ${city.name}`);

        } catch (err: any) {
          logger.error(`Error in category "${category}" / ${city.name}: ${err.message}`);
        }

        // Small delay between categories
        await delay(3000);
      }
    }
  } catch (err: any) {
    logger.error(`Fatal scraper error: ${err.message}`);
  }

  logger.info('Scraper finished');
}

if (require.main === module) {
  runScraper().catch(console.error);
}
