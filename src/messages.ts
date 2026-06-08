import { OpenAI } from 'openai';
import { dbHelpers, BusinessRecord } from './db';
import { createLogger } from './logger';

const logger = createLogger('messages');

const openai = new OpenAI({
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}`,
  defaultQuery: { 'api-version': process.env.AZURE_API_VERSION },
  defaultHeaders: { 'api-key': process.env.AZURE_OPENAI_API_KEY },
});

const MODEL = process.env.AZURE_OPENAI_DEPLOYMENT as string;

export interface GeneratedMessage {
  text: string;
}

/**
 * Remove long dashes (— and –) so messages read like a human typed them on a phone.
 * Spaced dashes used as punctuation become commas; hyphens inside words (авто-сервис) are kept.
 */
function humanize(text: string): string {
  return text
    // Number ranges keep a hyphen: "2–3", "100 – 150", "2-3" → "2-3", "100-150"
    .replace(/(\d)\s*[—–-]\s*(\d)/g, '$1-$2')
    // Em/en dash used as punctuation (between words) → comma
    .replace(/\s*[—–]\s*/g, ', ')
    // Spaced hyphen used as a dash between words (not digits) → comma
    .replace(/(\D)\s+-\s+(\D)/g, '$1, $2')
    // Repair ranges the model wrote with a bare space ("2 3 день", "100 150 контактов") → hyphen
    .replace(/(\d)\s+(\d+)(\s*(?:дн|день|дня|дней|контакт|номер|недел|час|месяц))/gi, '$1-$2$3')
    .replace(/\s*,\s*,\s*/g, ', ')    // collapse accidental double commas
    .replace(/\s{2,}/g, ' ')          // collapse double spaces
    .replace(/\s+([.!?,])/g, '$1')    // no space before punctuation
    .trim();
}

/** Check the cold first message: max 2 sentences, no price, no agency-speak. */
function validateMessage(text: string): { valid: boolean; reason?: string } {
  const priceRegex = /\b\d{2,3}\s*(?:-|–)?\s*\d{2,3}\s*к\b|\b\d{3}\s*(?:тыс|тысяч)|\b\d{2,3}\s*к\s*(?:тенге|тг)\b|\b\d{4,6}\s*(?:тенге|тг)\b/i;
  if (priceRegex.test(text)) {
    return { valid: false, reason: 'Contains price — forbidden in first message' };
  }

  const forbiddenWords = ['предлагаю', 'хотел бы', 'позвольте', 'наша компания', 'специализируемся', 'спектр услуг'];
  for (const word of forbiddenWords) {
    if (text.toLowerCase().includes(word)) {
      return { valid: false, reason: `Contains forbidden word: "${word}"` };
    }
  }

  // First message must be short and human: max 2 sentences (allow 3 as soft buffer before refine)
  const sentences = text.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);
  if (sentences.length > 3) {
    return { valid: false, reason: `Too many sentences (${sentences.length}), need ≤2` };
  }

  return { valid: true };
}

export async function generateMessage(business: BusinessRecord): Promise<GeneratedMessage> {
  // Reactivation product: we sell bringing back the business's OWN lapsed clients.
  const prompt = `
Пишешь первое холодное сообщение владельцу малого бизнеса в Казахстане в WhatsApp/Telegram.
Продукт: возврат СТАРЫХ клиентов этого бизнеса (реактивация базы) — рассылка по их же бывшим клиентам, чтобы те вернулись.

Бизнес: ${business.name}
Ниша: ${business.category}

ЦЕЛЬ сообщения — только получить ответ, не продать.

ЖЁСТКИЕ ПРАВИЛА:
- РОВНО 2 предложения. Коротко, по делу, БЕЗ воды и лишних оборотов.
- Пиши как живой человек с телефона, простыми словами. НЕ как агентство.
- ЗАПРЕЩЕНО длинное тире (— или –). Используй запятые и точки.
- НЕ называй цену, не пиши слово "услуга", без эмодзи.
- НЕ упоминай НИКАКОЙ город или регион в тексте.
- Можешь упомянуть название бизнеса один раз, естественно, или вообще без него.
- 1-е предложение (коротко): у них точно есть клиенты, которые ходили раньше и пропали, и их можно вернуть одним сообщением дешевле чем искать новых. Под нишу подбери кто это: барбер/салон, кто стригся; стоматология, пациенты что давно не были; автосервис, кто обслуживал машину; кафе, гости что заказывали; фитнес, кто ходил и забросил.
- 2-е предложение: короткий простой вопрос, например "Занимаюсь как раз этим, интересно?" или "Актуально вам?". БЕЗ города.

Выдай ТОЛЬКО текст сообщения, ровно 2 коротких предложения.
`;

  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: 'You write short human-sounding cold messages (max 2 sentences, no long dashes) for a client-reactivation service in Kazakhstan.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.8,
      max_completion_tokens: 160,
    });

    if (response.usage) {
      dbHelpers.logApiCost('generate_message', MODEL, response.usage.prompt_tokens, response.usage.completion_tokens);
    }

    let text = humanize(response.choices[0].message.content?.trim() || '');

    // Validate; one cheap refine only if it ran long
    const check = validateMessage(text);
    if (!check.valid) {
      logger.warn(`Message validation failed: ${check.reason}. Refining...`);
      const refineResponse = await openai.chat.completions.create({
        model: MODEL,
        messages: [
          { role: 'system', content: 'Сократи до РОВНО 2 коротких предложений, живой человеческий тон, без длинного тире и без цены. Выдай только текст.' },
          { role: 'user', content: text },
        ],
        temperature: 0.3,
        max_completion_tokens: 120,
      });
      if (refineResponse.usage) {
        dbHelpers.logApiCost('refine_message', MODEL, refineResponse.usage.prompt_tokens, refineResponse.usage.completion_tokens);
      }
      text = humanize(refineResponse.choices[0].message.content?.trim() || text);
    }

    return { text };
  } catch (err: any) {
    logger.error(`Error generating message: ${err.message}`);
    // Human fallback, no price, no long dash, 2 sentences.
    return {
      text: `Здравствуйте! У вас наверняка есть клиенты, которые ходили раньше и потом пропали, их реально вернуть одним сообщением и это в разы дешевле чем искать новых. Я как раз этим занимаюсь, интересно?`
    };
  }
}

// Follow-ups are DETERMINISTIC (no GPT) so they never drift off the reactivation product.
// Light variation per send so it doesn't look like an identical bot blast.
const FOLLOWUP_DAY5 = [
  'Здравствуйте! Не навязываюсь, просто напомню про себя. Ваших старых клиентов, которые давно не заходили, реально вернуть одним сообщением по базе, и это дешевле чем искать новых. Если актуально, расскажу как это работает.',
  'Здравствуйте! Напомню про себя, тема возврата старых клиентов. У вас в базе наверняка есть те, кто давно не появлялся, их можно вернуть одним сообщением, это выгоднее чем гнаться за новыми. Если интересно, подскажу как.',
  'Здравствуйте! Просто напомню о себе. Старых клиентов, которые перестали заходить, обычно реально вернуть одним аккуратным сообщением по вашей базе, дешевле чем искать новых. Если актуально, помогу разобраться.',
];
const FOLLOWUP_DAY12 = [
  'Понял вас, не отвлекаю. Если решите вернуть старых клиентов по базе, просто напишите, помогу.',
  'Хорошо, больше не беспокою. Надумаете вернуть старых клиентов, пишите, всегда на связи.',
  'Принял, не настаиваю. Если захотите поднять старую базу клиентов, просто дайте знать, помогу.',
];

export async function generateFollowUp(business: BusinessRecord, day: number): Promise<string> {
  const pool = day === 12 ? FOLLOWUP_DAY12 : FOLLOWUP_DAY5;
  return humanize(pool[Math.floor(Math.random() * pool.length)]);
}

export async function handleReply(
  business: BusinessRecord,
  chatHistory: any[],
  latestMessage: string
): Promise<{ replyText: string; action: 'reply' | 'stop_and_notify' | 'notify_and_reply' }> {
  
  // BUY SIGNAL or PRICE question → hand off to the human, who closes live (per playbook).
  // The human gets the full Stage-3 price script in the Telegram notification.
  const handoffRegex = /(сколько|цена|стоит|стоимость|прайс|по чём|почем|оплат|реквизит|давайте|согласен|согласна|готов|готова|запуск|запустим|запускаем|беру|по рукам|поехали|погнали)/i;
  if (handoffRegex.test(latestMessage)) {
    logger.info(`Buy/price signal detected: "${latestMessage}" → handing off to human`);
    return {
      replyText: 'Отлично. Сейчас прикину под вашу базу пару вариантов и напишу вам в течение часа, хорошо?',
      action: 'stop_and_notify',
    };
  }

  // CLEAR REFUSAL → graceful exit
  const refusalRegex = /(не интересно|не нужно|не надо|не пишите|отстаньте|уберите мой|не беспокойте|неинтересно)/i;
  if (refusalRegex.test(latestMessage)) {
    return {
      replyText: 'Понял вас, не отвлекаю. Если решите вернуть старых клиентов, просто напишите, помогу.',
      action: 'stop_and_notify',
    };
  }

  const historyText = chatHistory.map((m: any) => `${m.is_from_us ? 'Я' : 'Клиент'}: ${m.message}`).join('\n');

  // Stage 2 (explanation) + reassurance objections. Bot keeps the lead warm, never names price.
  const prompt = `
Ты частный специалист (не агентство), помогаешь малому бизнесу в Казахстане возвращать СТАРЫХ клиентов через рассылку по их же базе. Общаешься на "вы", просто, как живой человек.

История переписки:
${historyText}
Последнее сообщение клиента: "${latestMessage}"

Бизнес: ${business.name} (${business.category}, г. ${business.city})

Выбери тактику по смыслу сообщения клиента:
1. ЛЮБОПЫТСТВО ("как это", "что именно", "расскажите", "как работает") → Объясни просто: "Вы даёте список номеров клиентов которые у вас были, я составляю короткое сообщение с поводом вернуться (скидка, напоминание, новинка) и рассылаю по вашей базе. Те кто забыл, возвращаются и записываются, первые заявки обычно идут уже через пару дней." В конце спроси: "Сколько примерно клиентов у вас накопилось за всё время?". (Числа-диапазоны пиши словами, не используй "2-3".)
2. "ЭТО СПАМ? ЗАБАНЯТ?" → Успокой: "Нет, мы пишем вашим же клиентам которые у вас уже были и вас знают, это не холодная реклама чужим людям. Я соблюдаю лимиты и аккуратный график." Спроси готов ли попробовать.
3. "КТО ВЫ / ОТКУДА" → "Я частный специалист, помогаю местному бизнесу возвращать старых клиентов рассылкой по их базе, работаю напрямую без агентства." Коротко верни к делу.
4. "НЕТ БАЗЫ / НЕТ СПИСКА" → "База почти всегда есть, просто разбросана: переписки в WhatsApp, журнал записи, директ в Instagram, контакты в телефоне. Помогу собрать, даже небольшой базы в пару сотен контактов уже хватает для результата." Спроси сколько примерно наберётся. (Числа-диапазоны пиши словами, не "100-150".)
5. ОБЩЕЕ/НЕЙТРАЛЬНОЕ → Коротко поясни ценность возврата старых клиентов и задай вопрос про размер базы.

ЖЁСТКИЕ ПРАВИЛА:
- 1-2 коротких предложения, живой человеческий тон.
- ЗАПРЕЩЕНО длинное тире (— или –), используй запятые.
- НЕ называй цену вообще (цену скажет человек позже). Без слов "услуга", "предлагаю", "наша компания".
- Всегда заканчивай вопросом, который двигает к размеру базы или к согласию.

Верни СТРОГО JSON: {"replyText": "...", "action": "reply"}
`;

  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: 'You handle replies for a client-reactivation service in Kazakhstan. Keep leads warm, never name a price, hand off happens elsewhere. Always return valid JSON. No long dashes.' },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.5,
      max_completion_tokens: 200,
    });

    if (response.usage) {
      dbHelpers.logApiCost('handle_reply', MODEL, response.usage.prompt_tokens, response.usage.completion_tokens);
    }

    const content = response.choices[0].message.content?.trim() || '{}';
    const r = JSON.parse(content);
    return {
      replyText: humanize(r.replyText || 'Расскажу подробнее. Сколько примерно клиентов у вас накопилось за всё время?'),
      action: r.action === 'stop_and_notify' ? 'stop_and_notify' : 'reply',
    };
  } catch {
    return { replyText: 'Сейчас отвечу подробнее, пара минут.', action: 'notify_and_reply' };
  }
}
