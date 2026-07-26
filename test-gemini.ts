import { GoogleGenAI, Type } from '@google/genai';

const run = async () => {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const chat = ai.chats.create({
    model: 'gemini-3.1-pro-preview',
    config: {
      tools: [{
        functionDeclarations: [
          {
            name: "update_memory",
            description: "Updates memory slots",
            parameters: {
              type: Type.OBJECT,
              properties: {
                category: { type: Type.STRING },
                mode: { type: Type.STRING },
                content: { type: Type.STRING }
              }
            }
          }
        ]
      }]
    }
  });

  const response = await chat.sendMessage({ message: "Say hello and then call update_memory with category='test', mode='override', content='hello'" });
  console.log('TEXT:', response.text);
  console.log('FUNC CALLS:', JSON.stringify(response.functionCalls, null, 2));
}
run();
