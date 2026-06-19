import { NextResponse } from 'next/server';
import { SarvamAIClient } from 'sarvamai';

export async function POST(req: Request) {
  try {
    const { text, languageCode } = await req.json();

    if (!text) {
      return NextResponse.json({ error: 'No text provided' }, { status: 400 });
    }

    const sarvamKey = process.env.SARVAM_API_KEY;
    if (!sarvamKey) {
      console.error('SARVAM_API_KEY is not set in environment variables');
      return NextResponse.json({ error: 'TTS service is not configured' }, { status: 500 });
    }

    // Map language Code to Sarvam TTS target language code
    // En -> en-IN, hi -> hi-IN
    const targetLang = languageCode === 'hi' ? 'hi-IN' : 'en-IN';
    const speaker = 'ritu';

    const client = new SarvamAIClient({
      apiSubscriptionKey: sarvamKey,
    });

    const response = await client.textToSpeech.convert({
      model: "bulbul:v3",
      text: text,
      target_language_code: targetLang as any,
      speaker: speaker,
    });

    // The SDK returns the JSON response, pass it back to frontend
    return NextResponse.json(response);
  } catch (error: any) {
    console.error('Error proxying to Sarvam TTS via SDK:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
