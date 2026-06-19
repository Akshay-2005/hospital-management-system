// lib/contracts/voice.ts  — FROZEN
// Shared contract between Track A (Voice Registration) and Track B (AI Booking).
// Changes require a joint PR from both tracks.

export type LanguageCode = 'en' | 'hi'; // launch set; extend by config

// The handoff payload Track A produces and Track B consumes.
export interface RegistrationResult {
  patientId: string;
  organisationId: string;   // scopes ALL of Track B's queries
  language: LanguageCode;    // session language chosen in Step 1
  patientName: string;       // for personalised TTS in booking
  setupLink?: string;        // password setup link
}

// The shared voice kernel that BOTH tracks call (impl owned by A, see §4).
export interface VoiceSession {
  language: LanguageCode;
  listen(expectedType?: 'boolean' | 'text'): Promise<{ text: string; confidence: number }>; // L1 + L2 (STT)
  speak(text: string): Promise<void>;                       // L6 (TTS)
  get<T>(key: string): T | undefined;                       // session memory
  set<T>(key: string, value: T): void;
}
