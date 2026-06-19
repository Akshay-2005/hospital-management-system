import { NextResponse } from 'next/server';
import { SarvamAIClient } from 'sarvamai';

const client = new SarvamAIClient({
  apiSubscriptionKey: process.env.SARVAM_API_KEY || '',
});

export async function POST(req: Request) {
  try {
    const { text, sourceLang, targetLang } = await req.json();

    if (!text) {
      return NextResponse.json({ error: 'Missing text' }, { status: 400 });
    }

    if (!process.env.SARVAM_API_KEY) {
      // Just fallback to the original text if no key is present
      return NextResponse.json({ translatedText: text });
    }

    // Call Sarvam Translation API natively via fetch as the SDK may be unstable
    const res = await fetch('https://api.sarvam.ai/translate', {
      method: 'POST',
      headers: {
        'api-subscription-key': process.env.SARVAM_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: text,
        source_language_code: sourceLang,
        target_language_code: targetLang,
        speaker_gender: 'Male', // generic
        mode: 'formal',
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Translate API failed: ${res.status} ${errText}`);
    }

    const data = await res.json();
    return NextResponse.json({
      translatedText: data.translated_text || text,
    });
  } catch (error: any) {
    console.error('Sarvam Translate error:', error);
    // If it fails, just return the original text so we don't break the flow
    return NextResponse.json({ translatedText: 'error' }, { status: 500 });
  }
}
