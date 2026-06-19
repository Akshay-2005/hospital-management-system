// lib/voice/tts.ts — [A] Text-to-Speech implementation
// Uses browser Web SpeechSynthesis as the v1 fallback.
// Production: swap to Coqui/XTTS without changing VoiceSession interface.

import type { LanguageCode } from '@/lib/contracts/voice';
import { TTS_LANG_MAP } from './i18n';

// Check if TTS is available
export function isTTSSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return !!window.speechSynthesis;
}

// Global AudioContext for Web Audio API playback
let audioCtx: AudioContext | null = null;

export function unlockAudio() {
  if (typeof window !== 'undefined') {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioContextClass) {
        audioCtx = new AudioContextClass();
      }
    }
    // Resume context on user gesture to unlock it permanently
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
  }
}

/**
 * Helper to decode base64 into an ArrayBuffer
 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

let currentAbortController: AbortController | null = null;

/**
 * Speak text using the browser's SpeechSynthesis API.
 * Returns a promise that resolves when speech is complete.
 */
export async function speakText(
  text: string,
  language: LanguageCode,
): Promise<void> {
  // First, stop any ongoing audio (browser TTS or HTML5 audio)
  stopSpeaking();

  return new Promise(async (resolve) => {
    try {
      currentAbortController = new AbortController();
      
      // Try Sarvam AI TTS first
      const res = await fetch('/api/public/voice/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, languageCode: language }),
        signal: currentAbortController.signal
      });

      if (res.ok) {
        const data = await res.json();
        if (data.audios && data.audios[0]) {
          
          if (!audioCtx) unlockAudio();
          
          if (audioCtx) {
            if (audioCtx.state === 'suspended') {
              await audioCtx.resume();
            }

            try {
              const arrayBuffer = base64ToArrayBuffer(data.audios[0]);
              const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
              
              const source = audioCtx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(audioCtx.destination);
              
              (window as any)._currentAudioSource = source;
              
              source.onended = () => {
                (window as any)._currentAudioSource = null;
                resolve();
              };
              
              source.start(0);
              return; // Success!

            } catch (playErr) {
              console.warn('[TTS] Web Audio API playback failed:', playErr);
              fallbackSpeak(text, language, resolve);
              return;
            }
          }
        }
      } else {
        const errText = await res.text();
        console.warn(`[TTS] Sarvam API returned error ${res.status}:`, errText);
      }
      
      // Fallback if API returned error or no audio
      fallbackSpeak(text, language, resolve);
      
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.log('[TTS] Fetch aborted');
        resolve();
        return;
      }
      console.warn('[TTS] Sarvam API or playback failed, using fallback:', err);
      fallbackSpeak(text, language, resolve);
    }
  });
}

function fallbackSpeak(text: string, language: LanguageCode, resolve: () => void) {
  if (!isTTSSupported()) {
    console.warn('[TTS] SpeechSynthesis not supported, text:', text);
    resolve();
    return;
  }

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = TTS_LANG_MAP[language] || 'en-IN';
  utterance.rate = 0.95;
  utterance.pitch = 1;
  utterance.volume = 1;

  const voices = window.speechSynthesis.getVoices();
  const langCode = TTS_LANG_MAP[language];
  
  // Try to find a female voice for the target language
  const targetLangPrefix = langCode.split('-')[0];
  const femaleVoice = voices.find(v => 
    v.lang.startsWith(targetLangPrefix) && 
    (v.name.toLowerCase().includes('female') || 
     v.name.toLowerCase().includes('girl') || 
     v.name.toLowerCase().includes('woman') || 
     v.name.toLowerCase().includes('zira') || 
     v.name.toLowerCase().includes('lekha') || 
     v.name.toLowerCase().includes('aditi'))
  );
  
  if (femaleVoice) {
    utterance.voice = femaleVoice;
  } else {
    // Fallback to the first available voice for that language
    const preferredVoice = voices.find(
      v => v.lang === langCode || v.lang.startsWith(targetLangPrefix)
    );
    if (preferredVoice) utterance.voice = preferredVoice;
  }

  utterance.onend = () => resolve();
  utterance.onerror = () => resolve();

  const MAX_CHUNK = 200;
  if (text.length > MAX_CHUNK) {
    const chunks = splitIntoChunks(text, MAX_CHUNK);
    speakChunks(chunks, language).then(resolve);
    return;
  }

  window.speechSynthesis.speak(utterance);
  setTimeout(() => resolve(), Math.max(text.length * 80, 5000));
}

function splitIntoChunks(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  const sentences = text.split(/(?<=[.!?।])\s+/);
  let current = '';

  for (const sentence of sentences) {
    if (current.length + sentence.length > maxLen && current.length > 0) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current += (current ? ' ' : '') + sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

async function speakChunks(chunks: string[], language: LanguageCode): Promise<void> {
  for (const chunk of chunks) {
    await speakText(chunk, language);
  }
}

/**
 * Stop any ongoing speech.
 */
export function stopSpeaking(): void {
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }

  if (isTTSSupported()) {
    window.speechSynthesis.cancel();
  }
  
  if (typeof window !== 'undefined') {
    if ((window as any)._currentAudio) {
      const audio = (window as any)._currentAudio as HTMLAudioElement;
      audio.pause();
      audio.currentTime = 0;
      (window as any)._currentAudio = null;
    }
    
    if ((window as any)._currentAudioSource) {
      try {
        const source = (window as any)._currentAudioSource as AudioBufferSourceNode;
        source.stop();
      } catch (e) {
        // Ignore errors if already stopped
      }
      (window as any)._currentAudioSource = null;
    }
  }
}

/**
 * Preload voices — some browsers load voices asynchronously.
 */
export function preloadVoices(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    if (!isTTSSupported()) {
      resolve([]);
      return;
    }
    
    const voices = window.speechSynthesis.getVoices();
    if (voices.length > 0) {
      resolve(voices);
      return;
    }

    window.speechSynthesis.onvoiceschanged = () => {
      resolve(window.speechSynthesis.getVoices());
    };

    // Fallback timeout
    setTimeout(() => resolve(window.speechSynthesis.getVoices()), 2000);
  });
}
