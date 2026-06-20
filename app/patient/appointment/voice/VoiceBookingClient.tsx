'use client';

/**
 * app/patient/appointment/voice/page.tsx
 * =====================================================================
 * Track B — Phase 4: Voice Booking Orchestration Page
 *
 * Flow: Welcome → Step 3 (Symptoms) → Step 4 (Doctors) →
 *       Step 5 (Slots) → Step 6 (Confirmation)
 *
 * - Reads RegistrationResult from URL search params; falls back to
 *   hardcoded mockRegistrationResult for local dev/testing.
 * - Implements a mock VoiceSession using the browser's native
 *   SpeechRecognition + SpeechSynthesis APIs (SSR-safe: all window
 *   access is gated behind typeof window !== 'undefined' checks).
 * - State is managed by a useReducer state machine with explicit
 *   step enums — no ambiguous boolean flags.
 * - All error paths (no doctors, no slots, emergency, booking failure)
 *   are handled with user-visible feedback + voice announcement.
 * =====================================================================
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

// UI Components (Track B, Phase 3)
import { DoctorCardList } from '@/components/booking/DoctorCard';
import { SlotCardList } from '@/components/booking/SlotCard';
import { ConfirmationCard } from '@/components/booking/ConfirmationCard';
import { EmergencyAdvisory } from '@/components/booking/EmergencyAdvisory';
import { VoiceBookingStatus, type VoiceState } from '@/components/booking/VoiceBookingStatus';

// Contracts (frozen seam)
import type {
  RegistrationResult,
  VoiceSession,
  DoctorCard,
  SlotCard,
  AppointmentCreationResult,
} from '@/lib/contracts/voice';

import { createVoiceSession } from '@/lib/voice/session';


// ─────────────────────────────────────────────────────────────────────────────
// Step enum — the canonical booking flow
// ─────────────────────────────────────────────────────────────────────────────

type BookingStep =
  | 'welcome'       // Landing — greet patient, explain flow
  | 'symptoms'        // Step 3 — capture symptoms via voice
  | 'low_confidence'  // Step 3 — NLU not sure; show department picker + ask to clarify
  | 'doctors'         // Step 4 — display + select doctor
  | 'date'            // Step 4.5 — select date
  | 'slots'           // Step 5 — display + select slot
  | 'confirming'      // Step 6 — booking in flight (spinner)
  | 'confirmed'       // Step 6 — booking complete (success card)
  | 'emergency'       // Red-flag emergency detected
  | 'error';          // Unrecoverable error

// ─────────────────────────────────────────────────────────────────────────────
// State shape
// ─────────────────────────────────────────────────────────────────────────────

interface BookingState {
  step: BookingStep;

  // Voice kernel display state
  voiceState: VoiceState;
  transcript: string;
  spokenText: string;

  // Step 3 — Symptom analysis results
  detectedSpecialties: string[];
  detectedRedFlags: string[];
  symptomText: string;
  /** Populated when NLU confidence < 0.5 — shown as department picker (per locked decision) */
  availableSpecialties: string[];
  /** NLU reasoning text to speak to the patient when confidence is low */
  lowConfidenceReasoning: string;

  // Step 4 — Doctor selection
  doctors: DoctorCard[];
  selectedDoctor: DoctorCard | null;
  loadingDoctorId: string | null;

  // Step 5 — Slot selection
  slots: SlotCard[];
  selectedSlot: SlotCard | null;
  slotDate: string;
  nextAvailableDate: string | null;

  // Step 6 — Confirmation
  appointmentResult: AppointmentCreationResult | null;

  // Error handling
  errorMessage: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Action union
// ─────────────────────────────────────────────────────────────────────────────

type BookingAction =
  | { type: 'SET_VOICE_STATE'; voiceState: VoiceState; transcript?: string; spokenText?: string }
  | { type: 'SET_TRANSCRIPT'; transcript: string }
  | { type: 'GO_TO_SYMPTOMS' }
  | { type: 'SYMPTOMS_ANALYSED'; specialties: string[]; redFlags: string[]; symptomText: string }
  | { type: 'EMERGENCY_DETECTED'; redFlags: string[] }
  /**
   * LOW_CONFIDENCE_DETECTED — NLU confidence < 0.5.
   * Per locked decision: NEVER silently auto-route. Show department picker.
   */
  | { type: 'LOW_CONFIDENCE_DETECTED'; availableSpecialties: string[]; reasoning: string; symptomText: string }
  | { type: 'DOCTORS_LOADED'; doctors: DoctorCard[] }
  | { type: 'DOCTOR_SELECTED'; doctor: DoctorCard }
  | { type: 'DATE_STEP_START' }
  | { type: 'DATE_SELECTED'; date: string }
  | { type: 'LOADING_SLOTS'; doctorId: string }
  | { type: 'SLOTS_LOADED'; slots: SlotCard[]; date: string; nextAvailableDate?: string | null }
  | { type: 'SLOT_SELECTED'; slot: SlotCard }
  | { type: 'BOOKING_START' }
  | { type: 'BOOKING_SUCCESS'; result: AppointmentCreationResult }
  | { type: 'SET_ERROR'; message: string }
  | { type: 'DISMISS_EMERGENCY' }
  | { type: 'RESET' };

// ─────────────────────────────────────────────────────────────────────────────
// Reducer
// ─────────────────────────────────────────────────────────────────────────────

const initialState: BookingState = {
  step: 'welcome',
  voiceState: 'idle',
  transcript: '',
  spokenText: '',
  detectedSpecialties: [],
  detectedRedFlags: [],
  symptomText: '',
  availableSpecialties: [],
  lowConfidenceReasoning: '',
  doctors: [],
  selectedDoctor: null,
  loadingDoctorId: null,
  slots: [],
  selectedSlot: null,
  slotDate: '',
  nextAvailableDate: null,
  appointmentResult: null,
  errorMessage: null,
};

function bookingReducer(state: BookingState, action: BookingAction): BookingState {
  switch (action.type) {
    case 'SET_VOICE_STATE':
      return {
        ...state,
        voiceState: action.voiceState,
        transcript: action.transcript ?? state.transcript,
        spokenText: action.spokenText ?? state.spokenText,
      };

    case 'SET_TRANSCRIPT':
      return { ...state, transcript: action.transcript };

    case 'GO_TO_SYMPTOMS':
      return { ...state, step: 'symptoms', voiceState: 'idle', errorMessage: null };

    case 'SYMPTOMS_ANALYSED':
      return {
        ...state,
        detectedSpecialties: action.specialties,
        detectedRedFlags: action.redFlags,
        symptomText: action.symptomText,
        voiceState: 'thinking',
      };

    case 'LOW_CONFIDENCE_DETECTED':
      return {
        ...state,
        step: 'low_confidence',
        symptomText: action.symptomText,
        availableSpecialties: action.availableSpecialties,
        lowConfidenceReasoning: action.reasoning,
        voiceState: 'idle',
      };

    case 'EMERGENCY_DETECTED':
      return {
        ...state,
        step: 'emergency',
        detectedRedFlags: action.redFlags,
        voiceState: 'idle',
      };

    case 'DOCTORS_LOADED':
      return {
        ...state,
        step: 'doctors',
        doctors: action.doctors,
        selectedDoctor: null,
        voiceState: 'idle',
      };

    case 'DOCTOR_SELECTED':
      return {
        ...state,
        selectedDoctor: action.doctor,
      };

    case 'DATE_STEP_START':
      return {
        ...state,
        step: 'date',
        voiceState: 'idle',
      };

    case 'DATE_SELECTED':
      return {
        ...state,
        slotDate: action.date,
      };

    case 'LOADING_SLOTS':
      return {
        ...state,
        loadingDoctorId: action.doctorId,
        voiceState: 'thinking',
      };

    case 'SLOTS_LOADED':
      return {
        ...state,
        step: 'slots',
        slots: action.slots,
        slotDate: action.date,
        nextAvailableDate: action.nextAvailableDate ?? null,
        loadingDoctorId: null,
        selectedSlot: null,
        voiceState: 'idle',
      };

    case 'SLOT_SELECTED':
      return { ...state, selectedSlot: action.slot };

    case 'BOOKING_START':
      return { ...state, step: 'confirming', voiceState: 'thinking' };

    case 'BOOKING_SUCCESS':
      return {
        ...state,
        step: 'confirmed',
        appointmentResult: action.result,
        voiceState: 'speaking',
        spokenText: `Your appointment has been confirmed! Your appointment ID is ${action.result.appointmentId}.`,
      };

    case 'SET_ERROR':
      return {
        ...state,
        step: 'error',
        errorMessage: action.message,
        voiceState: 'idle',
      };

    case 'DISMISS_EMERGENCY':
      // Let patient continue to manual/standard booking flow
      return {
        ...state,
        step: 'symptoms',
        voiceState: 'idle',
      };

    case 'RESET':
      return initialState;

    default:
      return state;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock VoiceSession factory (browser-only, SSR-safe)
// Uses SpeechRecognition for STT and SpeechSynthesis for TTS.
// This mock is deleted when Track A hands over the real VoiceSession.
// ─────────────────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────────────────
// Utility: get tomorrow's date as YYYY-MM-DD
// ─────────────────────────────────────────────────────────────────────────────

function getTomorrowDateStr(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Step label for the progress indicator
// ─────────────────────────────────────────────────────────────────────────────

const STEP_MAP: Record<BookingStep, number> = {
  welcome: 1,
  symptoms: 2,
  low_confidence: 2, // Still step 3 — clarification sub-step
  doctors: 3,
  slots: 4,
  confirming: 5,
  confirmed: 6,
  emergency: 2,
  error: 2,
};
const TOTAL_STEPS = 6;

// ─────────────────────────────────────────────────────────────────────────────
// Voice label per step
// ─────────────────────────────────────────────────────────────────────────────

const STEP_LABELS: Partial<Record<BookingStep, string>> = {
  symptoms: 'Tell me your symptoms',
  low_confidence: 'Please clarify or choose a department',
  doctors: 'Select a doctor',
  slots: 'Select a time slot',
  confirming: 'Booking your appointment…',
};

// ─────────────────────────────────────────────────────────────────────────────
// Inner page (uses useSearchParams — must be wrapped in Suspense)
// ─────────────────────────────────────────────────────────────────────────────

function VoiceBookingPageInner({
  initialOrgId,
  sessionPatientId,
  sessionPatientName,
}: {
  initialOrgId?: string;
  sessionPatientId?: string;
  sessionPatientName?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // ── Resolve RegistrationResult: URL params ──────────────
  const registration = useMemo<RegistrationResult | null>(() => {
    const patientId = searchParams.get('patientId') || sessionPatientId;
    const organisationId = searchParams.get('organisationId') || searchParams.get('orgId') || initialOrgId;
    const language = searchParams.get('language') as 'en' | 'hi' | null;
    const patientName = searchParams.get('patientName') || searchParams.get('name') || sessionPatientName;

    if (patientId && organisationId) {
      return {
        patientId,
        organisationId,
        language: language ?? 'en',
        patientName: patientName ?? 'Patient',
      };
    }

    return null; // Return null instead of mock data
  }, [searchParams, initialOrgId]);

  // Hook-safe early return for missing data
  if (!registration) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-red-100 text-center max-w-sm">
          <div className="w-12 h-12 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto mb-3">⚠️</div>
          <h2 className="text-lg font-bold text-gray-800">Missing Patient Data</h2>
          <p className="text-sm text-gray-500 mt-2 mb-5">Please complete the patient registration step first.</p>
          <button onClick={() => router.push('/patient/register')} className="w-full px-4 py-2.5 bg-blue-600 text-white font-semibold rounded-xl text-sm">
            Go to Registration
          </button>
        </div>
      </div>
    );
  }

  // ── Reducer ────────────────────────────────────────────────────────────────
  const [state, dispatch] = useReducer(bookingReducer, initialState);

  // ── VoiceSession (singleton ref — created once, browser-only) ─────────────
  const voiceSessionRef = useRef<VoiceSession | null>(null);

  // Memoized transcript updater for the listen() callback
  const handleInterimTranscript = useCallback((text: string) => {
    dispatch({ type: 'SET_TRANSCRIPT', transcript: text });
  }, []);

  // ── Initialize Real Voice Session ─────────────
  useEffect(() => {
    if (typeof window !== 'undefined' && !voiceSessionRef.current) {
      voiceSessionRef.current = createVoiceSession(registration.language);
    }
  }, [registration.language]);

  // ─────────────────────────────────────────────────────────────────────────
  // Helper: speak + update state
  // ─────────────────────────────────────────────────────────────────────────

  const speak = useCallback(async (text: string) => {
    dispatch({ type: 'SET_VOICE_STATE', voiceState: 'speaking', spokenText: text });
    await voiceSessionRef.current?.speak(text);
    // After speaking, reset to idle so the UI becomes interactive
    dispatch({ type: 'SET_VOICE_STATE', voiceState: 'idle' });
  }, []);

  const listen = useCallback(async (): Promise<{ text: string; confidence: number }> => {
    dispatch({ type: 'SET_VOICE_STATE', voiceState: 'listening', transcript: '' });
    
    // Call the real Sarvam API engine
    const result = await voiceSessionRef.current?.listen() ?? { text: '', confidence: 0 };
    
    dispatch({ type: 'SET_VOICE_STATE', voiceState: 'thinking', transcript: result.text });
    return result;
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
  // Step 3: Symptom capture flow
  // ─────────────────────────────────────────────────────────────────────────

  const runSymptomStep = useCallback(async (skipGreeting = false) => {
    if (!skipGreeting) {
      const firstName = registration.patientName.split(' ')[0];
      await speak(
        `Hello ${firstName}! I'm your AI booking assistant. Please describe your symptoms, and I'll find the right doctor for you.`
      );
    }

    // Listen for symptoms
    let symptomText = '';
    try {
      const result = await listen();
      symptomText = result.text;
    } catch (error) {
      console.error('[VoiceBooking] listen() error:', error);
    }

    if (!symptomText.trim()) {
      await speak('I didn\'t catch that. Could you please describe your symptoms?');
      dispatch({ type: 'GO_TO_SYMPTOMS' });
      return;
    }

    // Analyse symptoms via NLU API
    dispatch({ type: 'SET_VOICE_STATE', voiceState: 'thinking' });
    await speak('Got it. Let me analyse your symptoms…');
    try {
      const payload = {
        symptomText,
        organisationId: registration.organisationId,
      };

      const nluRes = await fetch('/api/voice/nlu/symptoms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!nluRes.ok) throw new Error(`NLU API error: ${nluRes.status}`);
      const nlu = await nluRes.json();

      // Emergency detection — highest priority
      if (nlu.isEmergency) {
        dispatch({ type: 'EMERGENCY_DETECTED', redFlags: nlu.redFlags ?? [] });
        await speak(
          'I have detected emergency symptoms in what you described. Please call 108 or go to the nearest emergency room immediately.'
        );
        return;
      }

      // ── LOW-CONFIDENCE path (Locked Decision: NEVER silently auto-route) ──
      // If confidence < 0.5 OR no specialties returned, we must ask the patient
      // to clarify or choose a department manually. We do NOT fall back to
      // General Medicine silently. Per task.md §6 locked decision.
      const isLowConfidence = (nlu.confidence ?? 1) < 0.5 || !nlu.specialties?.length;
      if (isLowConfidence) {
        const availableSpecialties: string[] = nlu.availableSpecialties ?? [];
        const reasoning: string = nlu.reasoning
          || 'I wasn\'t sure which department would suit you best.';

        dispatch({
          type: 'LOW_CONFIDENCE_DETECTED',
          availableSpecialties,
          reasoning,
          symptomText,
        });

        // Speak the uncertainty reason + ask patient to pick
        const departmentList = availableSpecialties.slice(0, 5).join(', ');
        await speak(
          `${reasoning} Could you describe your symptoms in a bit more detail, or please tap a department from the list below to continue.`
          + (departmentList ? ` Available departments include: ${departmentList}.` : '')
        );
        return;
      }

      // ── HIGH-CONFIDENCE path ──────────────────────────────────────────────
      dispatch({
        type: 'SYMPTOMS_ANALYSED',
        specialties: nlu.specialties,
        redFlags: nlu.redFlags ?? [],
        symptomText,
      });

      const specialty = nlu.specialties[0];
      await speak(`Based on your symptoms, I'll look for a ${specialty} specialist.`);
      await runDoctorStep(specialty);

    } catch (err) {
      console.error('[VoiceBooking] Symptom NLU error:', err);
      await speak('I had trouble analysing your symptoms. Please try again.');
      dispatch({ type: 'GO_TO_SYMPTOMS' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registration, speak, listen]);

  // ─────────────────────────────────────────────────────────────────────────
  // Step 4: Doctor listing + voice selection
  // ─────────────────────────────────────────────────────────────────────────

  const runDoctorStep = useCallback(async (specialty: string) => {
    dispatch({ type: 'SET_VOICE_STATE', voiceState: 'thinking' });

    try {
      const params = new URLSearchParams({ specialty, available: 'true' });
      const res = await fetch(
        `/api/organisations/${registration.organisationId}/doctors?${params}`
      );

      if (!res.ok) throw new Error(`Doctors API error: ${res.status}`);
      const data = await res.json();
      const doctors: DoctorCard[] = data.doctors ?? [];

      dispatch({ type: 'DOCTORS_LOADED', doctors });

      if (doctors.length === 0) {
        await speak(
          `I couldn't find any ${specialty} doctors available right now. Let me look for a General Medicine doctor.`
        );
        // Retry with General Medicine
        if (specialty !== 'General Medicine') {
          await runDoctorStep('General Medicine');
          return;
        }
        await speak('No doctors are available at this time. Please try again later or call the reception.');
        dispatch({ type: 'SET_ERROR', message: 'No doctors available. Please contact reception.' });
        return;
      }

      // Read out the available doctors
      const doctorList = doctors
        .slice(0, 3) // Read max 3 to avoid overwhelming the patient
        .map((d, i) => `Doctor ${i + 1}: Dr. ${d.name}, ${d.specialty}`)
        .join('. ');
      await speak(`I found ${doctors.length} doctor${doctors.length > 1 ? 's' : ''}. ${doctorList}. Please tap a doctor card to select, or say the doctor number.`);

      // Listen for voice selection
      const { text: voiceChoice } = await listen();
      const chosenDoctor = parseVoiceDoctorChoice(voiceChoice, doctors);

      if (chosenDoctor) {
        await handleDoctorSelected(chosenDoctor);
      } else {
        // No valid voice choice — let the user tap the card manually
        dispatch({ type: 'SET_VOICE_STATE', voiceState: 'idle' });
        await speak('Please tap a doctor card to make your selection.');
      }

    } catch (err) {
      console.error('[VoiceBooking] Doctor fetch error:', err);
      await speak('I had trouble fetching available doctors. Please try again.');
      dispatch({ type: 'GO_TO_SYMPTOMS' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registration, speak, listen]);

  /** Parse voice input for doctor index selection ("doctor 1", "first", "1", etc.) */
  function parseVoiceDoctorChoice(text: string, doctors: DoctorCard[]): DoctorCard | null {
    if (!text) return null;
    const lower = text.toLowerCase();
    // Check for doctor name mention (ignore "Dr.")
    for (const doc of doctors) {
      const docName = doc.name.toLowerCase().replace(/dr\.?\s*/g, '');
      if (lower.includes(docName)) return doc;
    }
    // Check for ordinal / number
    const ordinals = ['first', 'second', 'third', 'fourth', 'fifth'];
    const cardinals = ['one', 'two', 'three', 'four', 'five'];
    for (let i = 0; i < ordinals.length; i++) {
      const cardinalRegex = new RegExp(`\\b${cardinals[i]}\\b`);
      if (lower.includes(ordinals[i]) || lower.includes(String(i + 1)) || cardinalRegex.test(lower)) {
        return doctors[i] ?? null;
      }
    }
    return null;
  }

  const handleDoctorSelected = useCallback(async (doctor: DoctorCard) => {
    dispatch({ type: 'DOCTOR_SELECTED', doctor });
    dispatch({ type: 'DATE_STEP_START' });

    await speak(`Great choice! Dr. ${doctor.name}. What date would you like to book? For example, today or tomorrow.`);

    await runDateStep(doctor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speak]);

  function parseVoiceDateChoice(text: string): string | null {
    if (!text) return null;
    const lower = text.toLowerCase();
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dayAfter = new Date(today);
    dayAfter.setDate(dayAfter.getDate() + 2);

    const formatDate = (d: Date) => {
      const offset = d.getTimezoneOffset() * 60000;
      return (new Date(d.getTime() - offset)).toISOString().split('T')[0];
    };

    if (lower.includes('today')) return formatDate(today);
    if (lower.includes('tomorrow')) return formatDate(tomorrow);
    if (lower.includes('day after tomorrow')) return formatDate(dayAfter);

    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    for (let i = 0; i < days.length; i++) {
      if (lower.includes(days[i])) {
        const d = new Date(today);
        d.setDate(d.getDate() + ((i + 7 - d.getDay()) % 7 || 7));
        return formatDate(d);
      }
    }
    return null;
  }

  const runDateStep = useCallback(async (doctor: DoctorCard) => {
    const { text: voiceChoice } = await listen();
    const chosenDate = parseVoiceDateChoice(voiceChoice);

    if (chosenDate) {
      await handleDateSelected(doctor, chosenDate);
    } else {
      dispatch({ type: 'SET_VOICE_STATE', voiceState: 'idle' });
      await speak('Please tap a date or say today or tomorrow.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listen, speak]);

  const handleDateSelected = useCallback(async (doctor: DoctorCard, date: string) => {
    dispatch({ type: 'DATE_SELECTED', date });
    dispatch({ type: 'LOADING_SLOTS', doctorId: doctor.id });

    const d = new Date(date);
    const friendlyDate = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    await speak(`Got it, ${friendlyDate}. Let me check available slots.`);

    await runSlotStep(doctor, date);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speak]);

  // ─────────────────────────────────────────────────────────────────────────
  // Step 5: Slot listing + voice selection
  // ─────────────────────────────────────────────────────────────────────────

  const runSlotStep = useCallback(async (doctor: DoctorCard, dateStr: string) => {
    dispatch({ type: 'SET_VOICE_STATE', voiceState: 'thinking' });

    try {
      const params = new URLSearchParams({ date: dateStr, orgId: registration.organisationId });
      const res = await fetch(`/api/doctors/${doctor.id}/slots?${params}`);

      if (!res.ok) throw new Error(`Slots API error: ${res.status}`);
      const data = await res.json();
      const slots: SlotCard[] = data.slots ?? [];
      const nextAvailableDate: string | null = data.nextAvailableDate ?? null;

      dispatch({
        type: 'SLOTS_LOADED',
        slots,
        date: data.date ?? dateStr,
        nextAvailableDate,
      });

      if (slots.length === 0) {
        if (nextAvailableDate) {
          await speak(
            `No slots available for ${formatDateSpoken(dateStr)}. The next available date is ${formatDateSpoken(nextAvailableDate)}. Tap the button to view those slots.`
          );
        } else {
          await speak(
            `Dr. ${doctor.name} has no available slots in the next 7 days. Please select a different doctor.`
          );
        }
        return;
      }

      // Read first 3 slots
      const slotList = slots
        .slice(0, 3)
        .map((s, i) => `Slot ${i + 1}: ${formatTimeSpoken(s.startTime)}`)
        .join('. ');
      await speak(`Here are the available slots for ${formatDateSpoken(dateStr)}. ${slotList}. Please tap a slot or say the slot number.`);

      // Listen for voice slot selection
      const { text: voiceChoice } = await listen();
      const chosenSlot = parseVoiceSlotChoice(voiceChoice, slots);

      if (chosenSlot) {
        await handleSlotSelected(chosenSlot, doctor);
      } else {
        dispatch({ type: 'SET_VOICE_STATE', voiceState: 'idle' });
        await speak('Please tap a time slot to make your selection.');
      }

    } catch (err) {
      console.error('[VoiceBooking] Slot fetch error:', err);
      await speak('I had trouble fetching available slots. Please try again.');
      dispatch({ type: 'SET_VOICE_STATE', voiceState: 'idle' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registration, speak, listen]);

  function parseVoiceSlotChoice(text: string, slots: SlotCard[]): SlotCard | null {
    if (!text) return null;
    const lower = text.toLowerCase();
    const ordinals = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];
    const cardinals = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
    for (let i = 0; i < ordinals.length; i++) {
      const cardinalRegex = new RegExp(`\\b${cardinals[i]}\\b`);
      if (lower.includes(ordinals[i]) || lower.includes(String(i + 1)) || cardinalRegex.test(lower)) {
        return slots[i] ?? null;
      }
    }
    // Time mention: "nine am", "9 AM", etc.
    for (const slot of slots) {
      const spoken = formatTimeSpoken(slot.startTime).toLowerCase();
      if (lower.includes(slot.startTime) || lower.includes(spoken)) return slot;
    }
    return null;
  }

  const handleSlotSelected = useCallback(async (slot: SlotCard, doctor: DoctorCard) => {
    dispatch({ type: 'SLOT_SELECTED', slot });
    await speak(`You selected the ${formatTimeSpoken(slot.startTime)} slot. Let me confirm your booking now.`);
    await runBookingStep(slot, doctor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speak]);

  // ─────────────────────────────────────────────────────────────────────────
  // Step 6: Create appointment
  // ─────────────────────────────────────────────────────────────────────────

  const runBookingStep = useCallback(async (slot: SlotCard, doctor: DoctorCard) => {
    dispatch({ type: 'BOOKING_START' });

    const idempotencyKey = `voice-${registration.patientId}-${slot.id}-${Date.now()}`;

    try {
      const res = await fetch('/api/appointments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          patientId: registration.patientId,
          doctorId: doctor.id,
          slotId: slot.id,
          organisationId: registration.organisationId,
          reason: state.symptomText || 'Voice booking',
          idempotencyKey,
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        if (res.status === 409) {
          // Slot was just booked by someone else — let patient pick again
          await speak('That slot was just taken. Let me fetch the updated availability.');
          dispatch({ type: 'SLOTS_LOADED', slots: [], date: slot.date, nextAvailableDate: null });
          if (state.selectedDoctor) {
            await runSlotStep(state.selectedDoctor, slot.date);
          }
          return;
        }
        throw new Error(errData.error ?? `Booking failed: ${res.status}`);
      }

      const result: AppointmentCreationResult = await res.json();

      dispatch({ type: 'BOOKING_SUCCESS', result });

      // Fire-and-forget notification
      fetch('/api/notifications/appointment-confirmation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          patientId: registration.patientId,
          appointmentId: result.appointmentId,
          organisationId: registration.organisationId,
        }),
      }).catch(console.warn);

    } catch (err) {
      console.error('[VoiceBooking] Booking error:', err);
      const message = err instanceof Error ? err.message : 'Booking failed. Please try again.';
      await speak(`I'm sorry, there was an error: ${message}. Please try again or contact reception.`);
      dispatch({ type: 'SET_ERROR', message });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registration, state.symptomText, state.selectedDoctor, speak]);

  // ─────────────────────────────────────────────────────────────────────────
  // Kick off symptom step automatically when page loads (Welcome → Symptoms)
  // ─────────────────────────────────────────────────────────────────────────

  const hasStarted = useRef(false);

  const startFlow = useCallback(() => {
    if (hasStarted.current) return;
    hasStarted.current = true;
    dispatch({ type: 'GO_TO_SYMPTOMS' });
    // Slight delay so browser speech synthesis is ready
    setTimeout(() => runSymptomStep(), 300);
  }, [runSymptomStep]);

  const handleMicPress = useCallback(() => {
    const session = voiceSessionRef.current as any;
    if (state.voiceState === 'listening') {
      // Tap to stop immediately
      session?.stopListening?.();
    } else if (state.voiceState === 'idle') {
      if (session?.isWaitingForTap?.()) {
        // User tapped to start listening!
        dispatch({ type: 'SET_VOICE_STATE', voiceState: 'listening', transcript: '' });
        session?.startListening?.();
      } else if (state.step === 'symptoms') {
        runSymptomStep(true);
      }
    } else if (state.step === 'welcome') {
      startFlow();
    }
  }, [state.voiceState, state.step, startFlow, runSymptomStep]);

  // ─────────────────────────────────────────────────────────────────────────
  // Handlers for tap-based selections (fallback when voice parse fails)
  // ─────────────────────────────────────────────────────────────────────────

  const onDoctorCardSelect = useCallback(async (doctor: DoctorCard) => {
    if (state.step !== 'doctors') return;
    await handleDoctorSelected(doctor);
  }, [state.step, handleDoctorSelected]);

  const onSlotCardSelect = useCallback(async (slot: SlotCard) => {
    if (state.step !== 'slots' || !state.selectedDoctor) return;
    await handleSlotSelected(slot, state.selectedDoctor);
  }, [state.step, state.selectedDoctor, handleSlotSelected]);

  const onTryNextDate = useCallback(async (date: string) => {
    if (!state.selectedDoctor) return;
    await runSlotStep(state.selectedDoctor, date);
  }, [state.selectedDoctor, runSlotStep]);

  // ─────────────────────────────────────────────────────────────────────────
  // Derived UI values
  // ─────────────────────────────────────────────────────────────────────────

  const currentStepNumber = STEP_MAP[state.step] ?? 1;
  const stepLabel = STEP_LABELS[state.step] ?? '';

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-indigo-50">
      {/* ── Page header ──────────────────────────────────────────────────────── */}
      <header className="bg-white/80 backdrop-blur-sm border-b border-gray-100 sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
          <div>
            <p className="text-xs text-gray-400 font-medium uppercase tracking-wide">AI Booking</p>
            <h1 className="text-base font-bold text-gray-900 leading-tight">
              {registration.patientName}
              <span className="ml-2 text-xs font-normal text-gray-400 font-mono">
                {registration.patientId}
              </span>
            </h1>
          </div>
          {/* Step indicator pill */}
          <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-blue-100 text-blue-700 text-xs font-bold">
            Step {currentStepNumber} / {TOTAL_STEPS}
          </span>
        </div>
      </header>

      {/* ── Emergency overlay (rendered on top of everything) ─────────────────── */}
      {state.step === 'emergency' && (
        <EmergencyAdvisory
          detectedSymptoms={state.detectedRedFlags}
          onCallEmergency={() => {/* tel: handled inside component */ }}
          onContinueManually={() => dispatch({ type: 'DISMISS_EMERGENCY' })}
          onDismiss={() => dispatch({ type: 'DISMISS_EMERGENCY' })}
        />
      )}

      {/* ── Main content ──────────────────────────────────────────────────────── */}
      <main className="max-w-2xl mx-auto px-4 py-6 space-y-6" id="voice-booking-main">

        {/* ── Voice status widget (always visible) ──────────────────────────── */}
        <section
          className="bg-white rounded-2xl border border-gray-100 shadow-sm shadow-blue-50/50 p-4"
          aria-label="Voice assistant status"
        >
          <VoiceBookingStatus
            state={state.voiceState}
            transcript={state.transcript}
            spokenText={state.spokenText}
            label={stepLabel}
            step={{ current: currentStepNumber, total: TOTAL_STEPS }}
            onMicPress={handleMicPress}
            disabled={state.voiceState === 'thinking' || state.voiceState === 'speaking'}
          />

        </section>

        {/* ── WELCOME SCREEN ────────────────────────────────────────────────── */}
        {state.step === 'welcome' && (
          <section
            className="bg-white rounded-2xl border border-blue-100 shadow-sm p-6 text-center space-y-4"
            aria-label="Welcome"
          >
            {/* Animated gradient icon */}
            <div className="flex items-center justify-center">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-200/60">
                <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"
                  />
                </svg>
              </div>
            </div>

            <div>
              <h2 className="text-xl font-black text-gray-900">
                Hi, {registration.patientName.split(' ')[0]}! 👋
              </h2>
              <p className="text-sm text-gray-500 mt-1 leading-relaxed">
                I'll help you book an appointment using your voice. Just describe your symptoms,
                and I'll find the right doctor for you.
              </p>
            </div>

            {/* Flow steps preview */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-left">
              {[
                { icon: '🩺', label: 'Describe Symptoms', step: '3' },
                { icon: '👨‍⚕️', label: 'Choose Doctor', step: '4' },
                { icon: '🕐', label: 'Pick Time Slot', step: '5' },
                { icon: '✅', label: 'Confirm Booking', step: '6' },
              ].map(({ icon, label, step }) => (
                <div key={step} className="flex flex-col items-center gap-1 p-2 rounded-xl bg-gray-50 border border-gray-100">
                  <span className="text-xl" aria-hidden="true">{icon}</span>
                  <span className="text-[10px] font-semibold text-gray-500 text-center leading-tight">{label}</span>
                </div>
              ))}
            </div>

            {/* CTA */}
            <button
              type="button"
              id="voice-booking-start-btn"
              onClick={startFlow}
              className="w-full py-3.5 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 text-white font-bold text-sm hover:from-blue-700 hover:to-indigo-700 active:scale-[0.98] transition-all shadow-md shadow-blue-200/50"
            >
              🎙 Start Voice Booking
            </button>

            <p className="text-xs text-gray-400">
              Or tap the microphone icon above to start speaking directly.
            </p>
          </section>
        )}

        {/* ── SYMPTOM STEP (listening/thinking state feedback) ──────────────── */}
        {state.step === 'symptoms' && (
          <section
            className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-3"
            aria-label="Symptom capture"
          >
            <h2 className="text-sm font-bold text-gray-700">Step 3 — Describe Your Symptoms</h2>
            <p className="text-xs text-gray-400 leading-relaxed">
              Speak naturally — describe any pain, discomfort, or health concerns you're experiencing.
              I'll analyse your symptoms and find the right specialist.
            </p>

            {state.transcript && (
              <div className="mt-2 bg-blue-50 border border-blue-100 rounded-xl px-4 py-3">
                <p className="text-xs font-semibold text-blue-400 uppercase tracking-wider mb-1">You said</p>
                <p className="text-sm text-blue-900 leading-relaxed italic">
                  &ldquo;{state.transcript}&rdquo;
                </p>
              </div>
            )}

            {/* Retry button (visible in idle state if flow stalled) */}
            {state.voiceState === 'idle' && (
              <button
                type="button"
                onClick={handleMicPress}
                className="w-full py-2.5 rounded-xl border-2 border-blue-200 text-blue-700 text-sm font-semibold hover:bg-blue-50 transition"
              >
                🎙 Tap to speak
              </button>
            )}
          </section>
        )}

        {/* ── LOW-CONFIDENCE STEP — department picker (Locked Decision §6) ──── */}
        {state.step === 'low_confidence' && (
          <section
            className="bg-white rounded-2xl border border-amber-200 shadow-sm p-5 space-y-4"
            aria-label="Department selection — low confidence"
            aria-live="polite"
          >
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-xl bg-amber-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                <svg className="w-5 h-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
              </div>
              <div>
                <h2 className="text-sm font-bold text-amber-800">Step 3 — Please Clarify</h2>
                <p className="text-xs text-amber-700 leading-relaxed mt-0.5">
                  {state.lowConfidenceReasoning || "I wasn't sure which department would suit you best."}
                  {' '}Please tap a department below or describe your symptoms in more detail.
                </p>
              </div>
            </div>

            {/* What you said */}
            {state.symptomText && (
              <div className="bg-amber-50 border border-amber-100 rounded-xl px-4 py-3">
                <p className="text-xs font-semibold text-amber-500 uppercase tracking-wider mb-1">You said</p>
                <p className="text-sm text-amber-900 italic leading-relaxed">&ldquo;{state.symptomText}&rdquo;</p>
              </div>
            )}

            {/* Department picker grid */}
            {state.availableSpecialties.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                  Choose a department
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {state.availableSpecialties.map((specialty) => (
                    <button
                      key={specialty}
                      type="button"
                      id={`dept-picker-${specialty.toLowerCase().replace(/\s+/g, '-')}`}
                      onClick={async () => {
                        dispatch({
                          type: 'SYMPTOMS_ANALYSED',
                          specialties: [specialty],
                          redFlags: [],
                          symptomText: state.symptomText,
                        });
                        await speak(`Looking for a ${specialty} specialist.`);
                        await runDoctorStep(specialty);
                      }}
                      className="text-left px-3 py-2.5 rounded-xl border-2 border-gray-200 bg-white hover:border-blue-400 hover:bg-blue-50 transition-all text-xs font-semibold text-gray-700 hover:text-blue-700 active:scale-[0.97]"
                    >
                      {specialty}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Try again button */}
            <button
              type="button"
              onClick={() => {
                hasStarted.current = false;
                dispatch({ type: 'GO_TO_SYMPTOMS' });
                setTimeout(() => {
                  hasStarted.current = true;
                  runSymptomStep();
                }, 200);
              }}
              className="w-full py-2.5 rounded-xl border-2 border-blue-200 text-blue-700 text-sm font-semibold hover:bg-blue-50 transition"
            >
              🎙 Describe symptoms again
            </button>
          </section>
        )}

        {/* ── DOCTOR SELECTION STEP ──────────────────────────────────────────── */}
        {(state.step === 'doctors' || (state.step === 'slots' && state.doctors.length > 0)) && (
          <section aria-label="Doctor selection" className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-gray-700">Step 4 — Choose a Doctor</h2>
              {state.detectedSpecialties.length > 0 && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 text-[10px] font-bold border border-blue-100">
                  {state.detectedSpecialties[0]}
                </span>
              )}
            </div>

            <DoctorCardList
              doctors={state.doctors}
              selectedDoctorId={state.selectedDoctor?.id ?? null}
              isDisabled={state.step !== 'doctors' || state.voiceState === 'thinking'}
              loadingDoctorId={state.loadingDoctorId}
              onSelect={onDoctorCardSelect}
              emptyMessage="No doctors found for this specialty. Retrying with General Medicine…"
            />
          </section>
        )}

        {/* ── DATE SELECTION STEP ──────────────────────────────────────────── */}
        {(state.step === 'date' || state.step === 'slots') && (
          <section aria-label="Date selection" className="space-y-3">
            <h2 className="text-sm font-bold text-gray-700">Step 4.5 — Pick a Date</h2>
            <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
              {Array.from({ length: 7 }).map((_, i) => {
                const d = new Date();
                d.setDate(d.getDate() + i);
                const offset = d.getTimezoneOffset() * 60000;
                const dateStr = (new Date(d.getTime() - offset)).toISOString().split('T')[0];
                const isSelected = state.slotDate === dateStr;
                const isDisabled = state.voiceState === 'thinking' || state.voiceState === 'speaking' || state.step === 'slots';
                return (
                  <button
                    key={dateStr}
                    type="button"
                    onClick={() => {
                        if (!isDisabled && state.selectedDoctor) {
                            handleDateSelected(state.selectedDoctor, dateStr);
                        }
                    }}
                    disabled={isDisabled}
                    className={`flex-shrink-0 flex flex-col items-center justify-center w-20 h-20 rounded-2xl border-2 transition-all ${
                        isSelected 
                            ? 'border-blue-600 bg-blue-50 text-blue-700 shadow-md' 
                            : 'border-gray-200 bg-white hover:border-blue-300 text-gray-600'
                    } ${isDisabled && !isSelected ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                  >
                    <span className="text-xs font-bold uppercase">{d.toLocaleDateString('en-US', { weekday: 'short' })}</span>
                    <span className="text-xl font-black mt-0.5">{d.getDate()}</span>
                    <span className="text-[10px] font-semibold mt-0.5 opacity-80">{d.toLocaleDateString('en-US', { month: 'short' })}</span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {/* ── SLOT SELECTION STEP ───────────────────────────────────────────── */}
        {state.step === 'slots' && (
          <section aria-label="Slot selection" className="space-y-3">
            <h2 className="text-sm font-bold text-gray-700">Step 5 — Pick a Time Slot</h2>

            <SlotCardList
              slots={state.slots}
              date={state.slotDate}
              selectedSlotId={state.selectedSlot?.id ?? null}
              isDisabled={state.voiceState === 'thinking' || state.voiceState === 'speaking'}
              onSelect={onSlotCardSelect}
              nextAvailableDate={state.nextAvailableDate}
              onTryNextDate={onTryNextDate}
            />
          </section>
        )}

        {/* ── CONFIRMING (in-flight spinner) ───────────────────────────────── */}
        {state.step === 'confirming' && (
          <section
            className="flex flex-col items-center justify-center py-10 gap-4"
            aria-label="Booking in progress"
            aria-live="polite"
          >
            <span
              className="w-12 h-12 rounded-full border-4 border-blue-200 border-t-blue-600 animate-spin"
              aria-hidden="true"
            />
            <p className="text-sm font-semibold text-gray-600">Confirming your appointment…</p>
            <p className="text-xs text-gray-400">Please wait, this takes just a moment.</p>
          </section>
        )}

        {/* ── CONFIRMED (success card) ──────────────────────────────────────── */}
        {state.step === 'confirmed' && state.appointmentResult && (
          <section aria-label="Booking confirmed" className="space-y-4">
            <h2 className="text-sm font-bold text-gray-700 text-center">Step 6 — Appointment Confirmed 🎉</h2>

            <ConfirmationCard
              appointmentId={state.appointmentResult.appointmentId ?? '—'}
              doctorName={state.appointmentResult.doctor?.name ?? state.selectedDoctor?.name ?? ''}
              specialty={state.appointmentResult.doctor?.specialty ?? state.selectedDoctor?.specialty ?? ''}
              appointmentDate={state.appointmentResult.appointmentDate ?? new Date().toISOString()}
              patientName={registration.patientName}
              patientId={registration.patientId}
              onGoToPortal={() => router.push('/patient/appointments')}
            />
          </section>
        )}

        {/* ── ERROR STATE ───────────────────────────────────────────────────── */}
        {state.step === 'error' && (
          <section
            className="bg-red-50 border-2 border-red-200 rounded-2xl p-6 text-center space-y-4"
            role="alert"
            aria-label="Booking error"
          >
            <div className="flex items-center justify-center">
              <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center">
                <svg className="w-6 h-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.072 16.5c-.77.833.192 2.5 1.732 2.5z"
                  />
                </svg>
              </div>
            </div>

            <div>
              <h2 className="text-base font-bold text-red-800">Something went wrong</h2>
              <p className="text-xs text-red-600 mt-1">{state.errorMessage ?? 'An unexpected error occurred.'}</p>
            </div>

            <div className="flex flex-col sm:flex-row gap-2">
              <button
                type="button"
                onClick={() => {
                  hasStarted.current = false;
                  dispatch({ type: 'RESET' });
                  setTimeout(() => startFlow(), 100);
                }}
                className="flex-1 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-bold hover:bg-blue-700 transition"
              >
                Try Again
              </button>
              <button
                type="button"
                onClick={() => router.push('/patient/appointments')}
                className="flex-1 py-2.5 rounded-xl border-2 border-gray-200 text-gray-600 text-sm font-semibold hover:bg-gray-50 transition"
              >
                Book Manually
              </button>
            </div>
          </section>
        )}

      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Spoken text helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatTimeSpoken(time: string): string {
  const [hourStr, min] = time.split(':');
  const hour = parseInt(hourStr, 10);
  const period = hour < 12 ? 'AM' : 'PM';
  const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${h12}:${min} ${period}`;
}

function formatDateSpoken(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-IN', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    });
  } catch {
    return iso;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Page export — wrapped in Suspense (required for useSearchParams in Next.js)
// ─────────────────────────────────────────────────────────────────────────────

export default function VoiceBookingClient({
  initialOrgId,
  sessionPatientId,
  sessionPatientName,
}: {
  initialOrgId?: string;
  sessionPatientId?: string;
  sessionPatientName?: string;
}) {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-white">
          <div className="text-center space-y-3">
            <span className="inline-block w-10 h-10 rounded-full border-4 border-blue-200 border-t-blue-600 animate-spin" />
            <p className="text-sm text-gray-500 font-medium">Loading AI assistant…</p>
          </div>
        </div>
      }
    >
      <VoiceBookingPageInner 
        initialOrgId={initialOrgId} 
        sessionPatientId={sessionPatientId}
        sessionPatientName={sessionPatientName}
      />
    </Suspense>
  );
}
