// lib/voice/stt.ts — [A] Speech-to-Text implementation
// Uses browser Web Speech API as the v1 implementation.
// Production: swap to Whisper (self-hosted or Groq) without changing VoiceSession interface.

import type { LanguageCode } from '@/lib/contracts/voice';
import { STT_LANG_MAP } from './i18n';

export interface STTResult {
  text: string;
  confidence: number;
}

export function isSTTSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

/**
 * Listen for speech input using MediaRecorder and Sarvam API.
 * Uses Web Audio API for Voice Activity Detection (VAD).
 */
export async function listenOnce(
  language: LanguageCode,
  timeoutMs: number = 15000,
  expectedType: 'boolean' | 'text' = 'text'
): Promise<STTResult> {
  if (!isSTTSupported()) {
    throw new Error('Microphone access is not supported in this browser');
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    throw new Error('Microphone access was denied');
  }

  return new Promise((resolve, reject) => {
    // 1. Setup AudioContext for VAD (Voice Activity Detection)
    const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    // 2. Setup MediaRecorder
    let mimeType = 'audio/webm';
    if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
      mimeType = 'audio/webm;codecs=opus';
    } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
      mimeType = 'audio/mp4';
    } else if (MediaRecorder.isTypeSupported('audio/ogg')) {
      mimeType = 'audio/ogg';
    }
    
    // --- FAST LOCAL PATH FOR BOOLEAN / SIMPLE RESPONSES ---
    if (expectedType === 'boolean') {
      console.log('[STT] Using fast local STT path for boolean response');
      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      const recognition = new SpeechRecognition();
      recognition.lang = STT_LANG_MAP[language];
      recognition.continuous = false; // Stop immediately after the first phrase
      recognition.interimResults = true;
      
      let localResolved = false;
      const localFinish = (text: string, conf: number) => {
        if (localResolved) return;
        localResolved = true;
        recognition.stop();
        stream.getTracks().forEach(track => track.stop());
        try { audioContext.close(); } catch(e) {}
        resolve({ text, confidence: conf });
      };

      recognition.onresult = (e: any) => {
        let finalTranscript = '';
        let interimTranscript = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) {
            finalTranscript += e.results[i][0].transcript;
          } else {
            interimTranscript += e.results[i][0].transcript;
          }
        }
        if (finalTranscript.trim()) {
          localFinish(finalTranscript.trim(), e.results[e.resultIndex][0].confidence);
          return;
        }

        // Fast path: if the interim transcript has a clear yes/no, finish instantly!
        const interimStr = interimTranscript.trim().toLowerCase();
        if (interimStr) {
          const words = interimStr.split(/\s+/);
          const hasBool = words.some(w => /^(yes|yeah|yep|ok|okay|हाँ|हां|no|nope|नहीं)$/.test(w));
          if (hasBool) {
            localFinish(interimStr, 0.9);
          }
        }
      };

      recognition.onerror = (e: any) => {
        console.warn('[STT] Local recognition error:', e.error);
        if (e.error === 'network' || e.error === 'service-not-allowed') {
          console.warn('[STT] Local STT blocked (likely Brave browser). Falling back to Sarvam.');
          if (!localResolved) {
            localResolved = true;
            recognition.stop();
            stream.getTracks().forEach(track => track.stop());
            try { audioContext.close(); } catch(e) {}
            // Transparently retry using the text path (Sarvam)
            resolve(listenOnce(language, timeoutMs, 'text'));
          }
        } else {
          // For other errors like 'no-speech', just return empty string so the FSM retries
          localFinish('', 0);
        }
      };

      recognition.onend = () => {
        localFinish('', 0);
      };

      setTimeout(() => {
        localFinish('', 0);
      }, timeoutMs);

      recognition.start();
      return;
    }

    // --- STANDARD SARVAM API PATH FOR TEXT RESPONSES ---
    const mediaRecorder = new MediaRecorder(stream, { mimeType });
    const audioChunks: Blob[] = [];

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };

    let resolved = false;

    const finish = () => {
      if (resolved) return;
      resolved = true;
      console.log('[STT] Stopping recorder and processing audio...');
      clearTimeout(maxTimeout);
      clearTimeout(silenceTimer);
      stream.getTracks().forEach(track => track.stop());
      try { audioContext.close(); } catch(e) {}
      if (mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
      }
    };

    mediaRecorder.onstop = async () => {
      if (audioChunks.length === 0) {
        console.warn('[STT] No audio recorded');
        resolve({ text: '', confidence: 0 });
        return;
      }
      
      const cleanMimeType = mimeType.split(';')[0];
      const audioBlob = new Blob(audioChunks, { type: cleanMimeType });
      console.log(`[STT] Audio recorded, size: ${audioBlob.size} bytes, type: ${cleanMimeType}`);
      const formData = new FormData();
      const ext = cleanMimeType.includes('mp4') ? 'mp4' : cleanMimeType.includes('ogg') ? 'ogg' : 'webm';
      formData.append('file', audioBlob, `audio.${ext}`);
      formData.append('language_code', language === 'hi' ? 'hi-IN' : 'en-IN');

      try {
        console.log('[STT] Sending to Sarvam...');
        const res = await fetch('/api/public/voice/stt', {
          method: 'POST',
          body: formData,
        });
        
        if (!res.ok) {
          const err = await res.text();
          throw new Error(`Transcription failed: ${res.status} ${err}`);
        }
        
        const data = await res.json();
        console.log('[STT] Sarvam response:', data);
        
        let transcript = data.transcript || '';
        let translatedText = '';

        if (transcript && language === 'hi') {
          try {
            const transRes = await fetch('/api/public/voice/translate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                text: transcript,
                sourceLang: 'hi-IN',
                targetLang: 'en-IN',
              })
            });
            if (transRes.ok) {
              const transData = await transRes.json();
              if (transData.translatedText && transData.translatedText !== 'error') {
                translatedText = transData.translatedText;
                console.log('[STT] Translated to:', translatedText);
              }
            }
          } catch (e) {
            console.error('[STT] Translation error:', e);
          }
        }

        resolve({
          text: translatedText || transcript,
          confidence: 1,
        });
      } catch (err) {
        console.error('[STT] Sarvam STT failed:', err);
        resolve({ text: '', confidence: 0 }); // Fallback to empty so FSM can retry
      }
    };

    // VAD Logic
    let isSpeaking = false;
    let silenceTimer: NodeJS.Timeout;
    
    // Global timeout
    const maxTimeout = setTimeout(finish, timeoutMs);

    const resetSilenceTimer = (ms: number) => {
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(finish, ms);
    };

    // Give them 5 seconds to start speaking
    resetSilenceTimer(5000);

    const detectSilence = () => {
      if (resolved) return;

      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i];
      }
      const average = sum / bufferLength;

      // Lowered threshold to catch quiet speakers
      if (average > 5) {
        if (!isSpeaking) {
          console.log('[STT] Speech detected! (Volume:', Math.round(average), ')');
          isSpeaking = true;
        }
        // User is speaking, push the silence cutoff to 1.2 seconds from now
        // If it's a simple boolean question, only wait 600ms after they stop speaking.
        const delayMs = expectedType === 'boolean' ? 600 : 1200;
        resetSilenceTimer(delayMs);
      }

      requestAnimationFrame(detectSilence);
    };

    console.log('[STT] Listening started...');
    detectSilence();
    mediaRecorder.start();
  });
}

/**
 * Request microphone permission from the browser.
 * Returns true if permission is granted.
 */
export async function requestMicPermission(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Stop the stream immediately — we just needed permission
    stream.getTracks().forEach(track => track.stop());
    return true;
  } catch (err) {
    console.error('Mic permission error:', err);
    return false;
  }
}
