import { NextResponse } from 'next/server';
import { SarvamAIClient } from 'sarvamai';

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get('file');

    if (!file) {
      return NextResponse.json({ error: 'No audio file provided' }, { status: 400 });
    }

    const sarvamKey = process.env.SARVAM_API_KEY;
    if (!sarvamKey) {
      console.error('SARVAM_API_KEY is not set in environment variables');
      return NextResponse.json({ error: 'STT service is not configured' }, { status: 500 });
    }

    const client = new SarvamAIClient({
      apiSubscriptionKey: sarvamKey,
    });

    const langCode = formData.get('language_code') as string || 'en-IN';
    const isEnglish = langCode === 'en-IN';

    const response = await client.speechToText.transcribe({
      file: file as File,
      model: "saaras:v3",
      language_code: langCode as any,
      // If English is selected but they speak an Indian name, we want Latin script (translit), not Devanagari.
      mode: isEnglish ? "translit" : "transcribe"
    });

    return NextResponse.json(response);
  } catch (error: any) {
    console.error('Error proxying to Sarvam STT via SDK:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
