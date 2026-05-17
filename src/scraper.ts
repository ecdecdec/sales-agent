import { chromium } from 'playwright';
import { dbHelpers } from './db';
import winston from 'winston';
import fs from 'fs';

// Setup basic logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/scraper.log' }),
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// Categories and cities to scrape
const CITIES = ['almaty', 'astana', 'shymkent'];
const CATEGORIES = [
  'рестораны', 'салоны красоты', 'стоматологии', 'фитнес клубы',
  'автосервисы', 'строительные материалы', 'магазины одежды'
];

export async function runScraper() {
  logger.info('Starting 2GIS scraper');
  
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  
  const page = await context.newPage();

  try {
    for (const city of CITIES) {
      for (const category of CATEGORIES) {
        logger.info(`Scraping category "${category}" in ${city}`);
        
        try {
          const query = encodeURIComponent(`${category}`);
          const url = `https://2gis.kz/${city}/search/${query}`;
          
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(5000); // Wait for results to load

          // Keep scrolling down to load more results (simulate scroll)
          for (let i = 0; i < 5; i++) {
            await page.mouse.wheel(0, 1000);
            await page.waitForTimeout(2000);
          }
          
          // Get links to all businesses in the list
          const businessLinks = await page.$$eval('a[href*="/firm/"]', links => 
            links.map(l => l.getAttribute('href')).filter(Boolean) as string[]
          );
          
          const uniqueLinks = [...new Set(businessLinks)].slice(0, 20); // Process 20 per category for this run
          logger.info(`Found ${uniqueLinks.length} businesses for ${category} in ${city}`);
          
          for (const link of uniqueLinks) {
            const fullUrl = `https://2gis.kz${link}`;
            
            try {
              await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
              await page.waitForTimeout(2000); // Give it time to load data
              
              // Extract details
              const name = await page.$eval('h1', el => el.textContent?.trim()).catch(() => null);
              if (!name) continue; // Skip if no name
              
              const phoneEl = await page.$eval('a[href^="tel:"]', el => el.getAttribute('href')).catch(() => null);
              const phone = phoneEl ? phoneEl.replace('tel:', '') : null;
              
              const website = await page.$eval('a[href^="http"]:not([href*="2gis"])', el => el.getAttribute('href')).catch(() => null);
              
              const hasPhoto = await page.$('div[class*="gallery"]') !== null;
              
              const ratingText = await page.$eval('div[class*="rating"]', el => el.textContent).catch(() => '0');
              const rating = parseFloat(ratingText?.replace(',', '.') || '0');
              
              const reviewsText = await page.$eval('div[class*="reviews"]', el => el.textContent).catch(() => '0');
              const reviewsCount = parseInt(reviewsText?.replace(/[^0-9]/g, '') || '0', 10);
              
              const hasDescription = await page.$('div[class*="description"]') !== null;
              const hasHours = await page.$('div[class*="schedule"]') !== null;
              const hasSocials = await page.$('a[href*="instagram.com"]') !== null;
              
              const id = phone || fullUrl;
              
              // Save to DB
              dbHelpers.saveBusiness({
                id,
                name,
                category,
                city,
                phone,
                website,
                has_photo: hasPhoto,
                rating,
                reviews_count: reviewsCount,
                has_description: hasDescription,
                has_hours: hasHours,
                has_socials: hasSocials,
                url: fullUrl
              });
              
              logger.info(`Saved business: ${name}`);
              
            } catch (err: any) {
              logger.error(`Error scraping business ${fullUrl}: ${err.message}`);
            }
          }
        } catch (err: any) {
          logger.error(`Error processing category ${category} in ${city}: ${err.message}`);
        }
      }
    }
  } catch (err: any) {
    logger.error(`Fatal scraper error: ${err.message}`);
  } finally {
    await browser.close();
    logger.info('Scraper finished');
  }
}

// Allow running directly
if (require.main === module) {
  runScraper().catch(console.error);
}
