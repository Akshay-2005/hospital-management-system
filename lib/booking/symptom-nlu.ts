/**
 * lib/booking/symptom-nlu.ts
 * =====================================================================
 * Track B — Step 3 service: Symptom → Specialty NLU + Emergency Detection
 *
 * Architecture:
 *  1. Pre-LLM fast path: scan for red-flag keywords (deterministic, no latency)
 *  2. LLM path: GPT-4o call constrained by SPECIALTY_REFERENCE map
 *  3. Graceful fallback: if OpenAI is unavailable, return low-confidence result
 *     so the UI can ask the patient to choose a department manually.
 *
 * Guardrail: LLM is ONLY allowed to map to specialties that exist in
 * SPECIALTY_REFERENCE. It cannot invent departments (FR-3.5).
 * =====================================================================
 */

import type { SymptomNLUResponse } from '@/lib/contracts/voice';

// ─────────────────────────────────────────────────────────────────────────────
// Specialty reference map (symptom guardrail — FR-3.5)
// The LLM's output is constrained to keys in this map.
// ─────────────────────────────────────────────────────────────────────────────
export const SPECIALTY_REFERENCE: Record<string, string[]> = {
  'Cardiology':       ['chest pain', 'heart palpitation', 'shortness of breath', 'hypertension', 'high blood pressure', 'irregular heartbeat', 'heart attack', 'angina'],
  'Neurology':        ['headache', 'migraine', 'seizure', 'dizziness', 'memory loss', 'numbness', 'tingling', 'tremor', 'stroke', 'weakness', 'paralysis', 'epilepsy'],
  'Orthopedics':      ['joint pain', 'bone pain', 'fracture', 'back pain', 'knee pain', 'shoulder pain', 'hip pain', 'arthritis', 'swollen joint', 'sports injury'],
  'Gastroenterology': ['stomach pain', 'abdominal pain', 'nausea', 'vomiting', 'diarrhea', 'constipation', 'bloating', 'indigestion', 'acid reflux', 'blood in stool', 'jaundice', 'liver problem'],
  'Pulmonology':      ['cough', 'wheezing', 'asthma', 'breathlessness', 'chest tightness', 'tuberculosis', 'lung problem', 'pneumonia', 'copd'],
  'Dermatology':      ['rash', 'skin problem', 'itching', 'acne', 'eczema', 'psoriasis', 'hair loss', 'nail problem', 'lesion', 'allergy'],
  'Gynecology':       ['menstrual problem', 'period pain', 'pregnancy', 'vaginal discharge', 'pcos', 'fertility', 'menopause', 'pelvic pain', 'breast lump'],
  'Pediatrics':       ['child fever', 'infant', 'baby', 'child cough', 'child vomiting', 'childhood disease', 'vaccination child', 'growth problem'],
  'Psychiatry':       ['depression', 'anxiety', 'stress', 'insomnia', 'panic attack', 'suicidal thoughts', 'mood swings', 'bipolar', 'schizophrenia', 'mental health', 'addiction'],
  'Ophthalmology':    ['eye pain', 'blurred vision', 'red eye', 'watery eye', 'cataract', 'glaucoma', 'eye infection', 'vision problem'],
  'ENT':              ['ear pain', 'hearing loss', 'sore throat', 'tonsil', 'nasal congestion', 'sinus', 'runny nose', 'voice problem', 'throat infection', 'ear infection'],
  'Urology':          ['urinary problem', 'burning urination', 'kidney stone', 'frequent urination', 'blood in urine', 'prostate problem', 'bladder problem'],
  'Endocrinology':    ['diabetes', 'thyroid', 'weight gain', 'weight loss', 'hormonal problem', 'adrenal problem', 'sugar problem'],
  'Nephrology':       ['kidney problem', 'dialysis', 'chronic kidney disease', 'swelling legs', 'protein in urine'],
  'Oncology':         ['cancer', 'tumor', 'lump', 'chemotherapy', 'radiation therapy', 'biopsy'],
  'Rheumatology':     ['autoimmune', 'lupus', 'rheumatoid arthritis', 'gout', 'fibromyalgia', 'joint inflammation'],
  'General Medicine': ['fever', 'cold', 'flu', 'fatigue', 'weakness', 'general checkup', 'body ache', 'infection', 'not feeling well'],
};

// All valid specialty names as an array (used to constrain LLM output)
const VALID_SPECIALTIES = Object.keys(SPECIALTY_REFERENCE);

// ─────────────────────────────────────────────────────────────────────────────
// Emergency red-flag detection (FR-3.4)
// Pre-LLM fast path — conservative, deterministic
// ─────────────────────────────────────────────────────────────────────────────
const EMERGENCY_RED_FLAGS: string[] = [
  // Cardiac
  'chest pain', 'crushing chest', 'heart attack', 'chest pressure',
  // Neurological
  'stroke', 'sudden weakness', 'face drooping', 'arm weakness', 'slurred speech',
  'sudden severe headache', 'thunderclap headache', 'loss of consciousness', 'unconscious', 'seizure',
  // Respiratory
  'cannot breathe', 'can\'t breathe', 'severe breathlessness', 'choking', 'suffocating',
  // Bleeding
  'severe bleeding', 'blood vomiting', 'coughing blood', 'blood in urine severe',
  // Mental health emergency
  'suicidal', 'want to die', 'kill myself', 'end my life',
  // Allergic
  'anaphylaxis', 'throat swelling', 'tongue swelling',
  // Obstetric
  'labor pain', 'water broke', 'heavy bleeding pregnancy',
  // Trauma
  'accident', 'severe injury', 'broken bone visible', 'head injury',
];

/**
 * Fast deterministic red-flag scan (no LLM needed).
 * Returns matched flag phrases or empty array.
 */
function detectRedFlagsLocally(symptomText: string): string[] {
  const lower = symptomText.toLowerCase();
  return EMERGENCY_RED_FLAGS.filter(flag => lower.includes(flag));
}

// ─────────────────────────────────────────────────────────────────────────────
// GPT-4o call (mirrors app/lib/ai-service.ts pattern)
// ─────────────────────────────────────────────────────────────────────────────
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

async function callGPT4o(systemPrompt: string, userPrompt: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2, // Low temperature for consistent medical routing
      max_tokens: 400,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API error: ${response.status} — ${err}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

// ─────────────────────────────────────────────────────────────────────────────
// NLU System Prompt
// Strict guardrail: LLM can ONLY choose from VALID_SPECIALTIES.
// No clinical diagnosis — routing only.
// ─────────────────────────────────────────────────────────────────────────────
function buildSystemPrompt(): string {
  return `You are an AI medical triage assistant that maps patient-described symptoms to hospital specialties.

IMPORTANT RULES:
1. You NEVER diagnose. You only route to specialties.
2. You MUST only use specialties from this exact list:
   ${VALID_SPECIALTIES.join(', ')}
3. If symptoms match multiple specialties, list all relevant ones (primary first).
4. Always assess for emergencies first.
5. Return ONLY valid JSON — no markdown, no code blocks, no extra text.

Return JSON in this exact format:
{
  "specialties": ["PrimarySpecialty", "SecondarySpecialty"],
  "isEmergency": false,
  "redFlags": [],
  "confidence": 0.85,
  "reasoning": "One sentence explanation (max 20 words) suitable to be spoken to the patient"
}

If symptoms are very vague or unclear, set confidence below 0.5.
If emergency detected, set isEmergency: true and describe the emergency in redFlags array.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main exported function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyse a free-form symptom description and return specialty routing + red-flag assessment.
 *
 * Decision per user approval:
 * - If confidence < 0.5 OR specialties array is empty, return low confidence so the
 *   UI can ask the patient to clarify or choose a department manually.
 *   We do NOT silently auto-route to General Medicine.
 */
export async function analyseSymptoms(symptomText: string): Promise<SymptomNLUResponse> {
  // ─── Step 1: Fast local red-flag scan ──────────────────────────────────────
  const localRedFlags = detectRedFlagsLocally(symptomText);
  if (localRedFlags.length > 0) {
    // Confirmed emergency — no need to call LLM for routing
    return {
      specialties: ['Emergency'],
      redFlags: localRedFlags,
      isEmergency: true,
      confidence: 1.0,
      reasoning: 'Symptoms suggest a medical emergency requiring immediate care.',
    };
  }

  // ─── Step 2: LLM analysis ──────────────────────────────────────────────────
  try {
    const raw = await callGPT4o(buildSystemPrompt(), `Patient symptoms: "${symptomText}"`);

    // Strip any accidental markdown wrapping
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);

    // Sanitise: only keep specialties that exist in our reference map
    const validatedSpecialties: string[] = (parsed.specialties || [])
      .filter((s: string) => VALID_SPECIALTIES.includes(s));

    const validatedRedFlags: string[] = Array.isArray(parsed.redFlags) ? parsed.redFlags : [];
    const isEmergency: boolean = Boolean(parsed.isEmergency) || validatedRedFlags.length > 0;
    const confidence: number = typeof parsed.confidence === 'number'
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0.5;

    // If LLM returned specialties not in our list, or empty, mark low confidence
    // so the UI knows to ask the patient for clarification (per user decision)
    if (validatedSpecialties.length === 0) {
      return {
        specialties: [],
        redFlags: validatedRedFlags,
        isEmergency,
        confidence: 0,
        reasoning: parsed.reasoning || 'I could not determine the right department. Let me ask you a few more questions.',
      };
    }

    return {
      specialties: validatedSpecialties,
      redFlags: validatedRedFlags,
      isEmergency,
      confidence,
      reasoning: parsed.reasoning || `Your symptoms suggest ${validatedSpecialties[0]}.`,
    };
  } catch (error) {
    console.error('[SymptomNLU] LLM call failed:', error);
    // Graceful degradation: return zero-confidence result so the UI asks the patient
    return {
      specialties: [],
      redFlags: [],
      isEmergency: false,
      confidence: 0,
      reasoning: 'I had trouble understanding your symptoms. Could you describe them in a bit more detail?',
    };
  }
}

/** Returns the full list of valid specialty names (for UI department picker fallback) */
export function getValidSpecialties(): string[] {
  return [...VALID_SPECIALTIES];
}
