import { OpenAI } from 'openai';
import { BusinessRecord } from './db';

const openai = new OpenAI({
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}`,
  defaultQuery: { 'api-version': process.env.AZURE_API_VERSION },
  defaultHeaders: { 'api-key': process.env.AZURE_OPENAI_API_KEY },
});

export async function generateMessage(business: BusinessRecord): Promise<string> {
  const problems = JSON.parse(business.problems || '[]');
  const marketAnalysis = JSON.parse(business.market_analysis || '{}');
  const mainProblem = problems.length > 0 ? problems[0].title : 'Слабое присутствие онлайн';
  
  const prompt = `
Твоя задача — написать первое холодное сообщение владельцу бизнеса в Казахстане (WhatsApp/Telegram).
Бизнес: ${business.name} (${business.category}, г. ${business.city})
Контекст рынка: ${JSON.stringify(marketAnalysis)}
Что конкретно мы у них заметили: ${mainProblem}

ЖЕСТКИЕ ПРАВИЛА:
1. Пиши как реальный человек, НЕ как продажник.
2. Очень коротко: 2-3 предложения максимум.
3. Повседневный русский язык. НИКАКИХ формальных слов (предлагаю, сотрудничество, услуги, повышение продаж).
4. НИКОГДА не продавай и не предлагай услуги в первом сообщении.
5. Начни с конкретной вещи, которую ТЫ заметил в ИХ профиле/на сайте.
6. Заканчивай максимум ОДНИМ легким вопросом (например, "Это намеренно или руки не дошли?", "У вас вообще есть сайт?").

Примеры идеальных сообщений:
"Смотрел ваш профиль в 2GIS - там нет ни одной фотографии. Люди обычно смотрят фото перед тем как прийти. Давно хотели это исправить?"
"Гуглил [категория] в [город] - вас нет в первых результатах. У вас вообще есть сайт?"
"Нашёл вас в 2GIS но там нет описания и часов работы. Клиенты из-за этого могут уходить к конкурентам. Это намеренно или просто руки не дошли?"

Сгенерируй ТОЛЬКО текст сообщения. Никаких приветствий вроде "Доброе утро/день" - просто "Привет" или "Здравствуйте".
`;

  const response = await openai.chat.completions.create({
    model: process.env.AZURE_OPENAI_DEPLOYMENT as string,
    messages: [
      { role: "system", content: "You are a casual observer reaching out to a business owner. Speak naturally and directly." },
      { role: "user", content: prompt }
    ],
    temperature: 0.7,
  });

  return response.choices[0].message.content?.trim() || `Здравствуйте. Искал вас в 2GIS, профиль совсем пустой. Замечали, что конкуренты уводят клиентов из-за этого?`;
}

export async function generateFollowUp(business: BusinessRecord, day: number): Promise<string> {
    const marketAnalysis = JSON.parse(business.market_analysis || '{}');
    
    let instructions = "";
    if (day === 2) {
        instructions = `Напиши одно короткое сообщение (2 предложения). Приведи 1 конкретную статистику, важную для их ниши (${business.category}). Например: "Кстати, профили с фото в 2GIS получают в 4 раза больше переходов. На вашем ни одной." Никаких "просто хотел уточнить".`;
    } else if (day === 4) {
        instructions = `Напиши одно короткое сообщение (2 предложения). Приведи 1 реальный пример работы с похожим бизнесом и результат. Без воды.`;
    } else if (day === 7) {
        instructions = `Напиши финальное короткое сообщение. Искреннее, без давления. Пример: "Последний раз пишу - если актуально будет, напишите. Удачи с бизнесом"`;
    }

    const prompt = `
Бизнес: ${business.name} (${business.category})
${instructions}
Сгенерируй ТОЛЬКО текст сообщения.
    `;

    const response = await openai.chat.completions.create({
        model: process.env.AZURE_OPENAI_DEPLOYMENT as string,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
    });
    
    return response.choices[0].message.content?.trim() || "Если будет актуально - пишите.";
}

export async function handleReply(business: BusinessRecord, chatHistory: any[], latestMessage: string): Promise<{ replyText: string, action: 'reply' | 'stop_and_notify' | 'notify_and_reply' }> {
    const historyText = chatHistory.map((m: any) => `${m.is_from_us ? 'Я' : 'Клиент'}: ${m.message}`).join('\n');
    
    const prompt = `
Проанализируй ответ клиента на наше предложение. 
История переписки:
${historyText}
Последнее сообщение клиента: "${latestMessage}"

Бизнес: ${business.name}
Наша цена: ${business.gpt_price} тг (назови диапазон: от ${Math.floor((business.gpt_price||100000)*0.8)} до ${Math.ceil((business.gpt_price||100000)*1.2)} тг).

Выбери ОДИН подход и сгенерируй ответ:
1. Если ему интересно/любопытно -> задай 1 глубокий вопрос об их проблеме.
2. Если спрашивает цену -> назови диапазон сразу без увиливаний: "Зависит от объема, обычно от X до Y тг. Что именно нужно сделать?"
3. Если скептичен -> приведи один реальный пример с результатом. Без воды.
4. Если НЕ интересно -> напиши одно честное прощание (пример: "Понял, без проблем. Удачи в бизнесе!") и укажи action: "stop_and_notify".
5. Если согласен / "давайте делать" -> укажи action: "stop_and_notify" и сгенерируй текст "Отлично, сейчас передам контакты специалисту, он напишет детали."

ВЕРНИ ОТВЕТ СТРОГО В JSON:
{
  "replyText": "Текст сообщения для отправки",
  "action": "reply" | "stop_and_notify"
}
`;

    const response = await openai.chat.completions.create({
        model: process.env.AZURE_OPENAI_DEPLOYMENT as string,
        messages: [
            { role: "system", content: "You are an expert communicator handling client replies. Always return valid JSON." },
            { role: "user", content: prompt }
        ],
        temperature: 0.4,
    });

    const content = response.choices[0].message.content?.trim() || '{"replyText": "Сейчас уточню и вернусь к вам.", "action": "notify_and_reply"}';
    const cleanJson = content.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    
    try {
        return JSON.parse(cleanJson);
    } catch {
        return { replyText: "Принято. Отвечу чуть позже.", action: 'notify_and_reply' };
    }
}
