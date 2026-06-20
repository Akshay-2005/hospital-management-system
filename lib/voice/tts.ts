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

// ─── Auto-stop speech on page leave / reload ─────────────────────────────────
if (typeof window !== 'undefined') {
  // Fires on reload, tab close, navigating away
  window.addEventListener('beforeunload', () => {
    stopSpeaking();
  });

  // Fires when user switches tabs or minimizes
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopSpeaking();
    }
  });

  // Next.js client-side navigation fires popstate
  window.addEventListener('popstate', () => {
    stopSpeaking();
  });
}

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
        if (data.audios && data.audios.length > 0) {
          
          const isGoogleTTS = data.provider === 'google-tts';

          // ── Google TTS returns MP3 → use HTMLAudioElement (handles MP3 natively)
          if (isGoogleTTS) {
            try {
              const playChunksViaAudio = (chunks: string[], index: number): Promise<void> => {
                return new Promise((done) => {
                  if (index >= chunks.length || currentAbortController?.signal.aborted) {
                    done();
                    return;
                  }

                  const audio = new Audio(`data:audio/mpeg;base64,${chunks[index]}`);
                  (window as any)._currentAudio = audio;
                  audio.onended = () => {
                    (window as any)._currentAudio = null;
                    playChunksViaAudio(chunks, index + 1).then(done);
                  };
                  audio.onerror = (e) => {
                    console.warn('[TTS] Audio element playback error:', e);
                    (window as any)._currentAudio = null;
                    done(); // Skip this chunk
                  };
                  audio.play().catch((e) => {
                    console.warn('[TTS] Audio.play() rejected:', e);
                    done();
                  });
                });
              };

              console.log(`[TTS] Playing ${data.audios.length} chunk(s) via Audio element (Google TTS)`);
              await playChunksViaAudio(data.audios, 0);
              resolve();
              return;
            } catch (playErr) {
              console.warn('[TTS] Google TTS Audio element failed:', playErr);
              fallbackSpeak(text, language, resolve);
              return;
            }
          }

          // ── Sarvam returns WAV → use Web Audio API (decodeAudioData)
          if (!audioCtx) unlockAudio();
          
          if (audioCtx) {
            if (audioCtx.state === 'suspended') {
              await audioCtx.resume();
            }

            try {
              // Play array of base64 audio chunks sequentially
              const playNext = (index: number): Promise<void> => {
                return new Promise((done) => {
                  if (index >= data.audios.length || currentAbortController?.signal.aborted) {
                    done();
                    return;
                  }

                  const arrayBuffer = base64ToArrayBuffer(data.audios[index]);
                  audioCtx!.decodeAudioData(arrayBuffer).then((audioBuffer) => {
                    const source = audioCtx!.createBufferSource();
                    source.buffer = audioBuffer;
                    source.connect(audioCtx!.destination);
                    
                    (window as any)._currentAudioSource = source;
                    
                    source.onended = () => {
                      (window as any)._currentAudioSource = null;
                      playNext(index + 1).then(done);
                    };
                    
                    source.start(0);
                  }).catch((decodeErr) => {
                    console.warn('[TTS] decodeAudioData failed:', decodeErr);
                    done();
                  });
                });
              };

              await playNext(0);
              resolve();
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
        console.warn(`[TTS] API returned error ${res.status}:`, errText);
      }
      
      // Fallback if API returned error or no audio
      fallbackSpeak(text, language, resolve);
      
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.log('[TTS] Fetch aborted');
        resolve();
        return;
      }
      console.warn('[TTS] API or playback failed, using fallback:', err);
      fallbackSpeak(text, language, resolve);
    }
  });
}

function findBestVoice(language: LanguageCode): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  const langCode = TTS_LANG_MAP[language] || 'en-IN';
  const targetLangPrefix = langCode.split('-')[0];

  // Try to find a female voice for the target language
  const femaleVoice = voices.find(v => 
    v.lang.startsWith(targetLangPrefix) && 
    (v.name.toLowerCase().includes('female') || 
     v.name.toLowerCase().includes('girl') || 
     v.name.toLowerCase().includes('woman') || 
     v.name.toLowerCase().includes('zira') || 
     v.name.toLowerCase().includes('lekha') || 
     v.name.toLowerCase().includes('aditi'))
  );
  if (femaleVoice) return femaleVoice;

  // Fallback to any voice for that language
  const langVoice = voices.find(
    v => v.lang === langCode || v.lang.startsWith(targetLangPrefix)
  );
  if (langVoice) return langVoice;

  // For Hindi: also try 'hi' prefix since some browsers use 'hi' not 'hi-IN'
  if (language === 'hi') {
    const hiVoice = voices.find(v => v.lang.startsWith('hi'));
    if (hiVoice) return hiVoice;
  }

  return null;
}

function fallbackSpeak(text: string, language: LanguageCode, resolve: () => void) {
  if (!isTTSSupported()) {
    console.warn('[TTS] SpeechSynthesis not supported, text:', text);
    resolve();
    return;
  }

  const langCode = TTS_LANG_MAP[language] || 'en-IN';
  let resolved = false;
  const safeResolve = () => { if (!resolved) { resolved = true; resolve(); } };

  const doSpeak = () => {
    // Stop any queued speech first
    window.speechSynthesis.cancel();

    const MAX_CHUNK = 200;
    if (text.length > MAX_CHUNK) {
      const chunks = splitIntoChunks(text, MAX_CHUNK);
      speakChunks(chunks, language).then(safeResolve);
      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = langCode;
    utterance.rate = 0.95;
    utterance.pitch = 1;
    utterance.volume = 1;

    const voice = findBestVoice(language);
    if (voice) {
      utterance.voice = voice;
      console.log(`[TTS] Browser fallback using voice: ${voice.name} (${voice.lang})`);
    } else {
      console.warn(`[TTS] No voice found for ${langCode}, using default`);
    }

    utterance.onend = safeResolve;
    utterance.onerror = (e) => {
      console.warn('[TTS] Browser SpeechSynthesis error:', e);
      safeResolve();
    };

    window.speechSynthesis.speak(utterance);

    // Safety timeout — some browsers never fire onend
    setTimeout(safeResolve, Math.max(text.length * 80, 5000));
  };

  // Voices might not be loaded yet — wait for them
  const voices = window.speechSynthesis.getVoices();
  if (voices.length > 0) {
    doSpeak();
  } else {
    // Some browsers load voices async — wait up to 1s
    const handler = () => {
      window.speechSynthesis.onvoiceschanged = null;
      doSpeak();
    };
    window.speechSynthesis.onvoiceschanged = handler;
    setTimeout(() => {
      window.speechSynthesis.onvoiceschanged = null;
      doSpeak();
    }, 1000);
  }
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
