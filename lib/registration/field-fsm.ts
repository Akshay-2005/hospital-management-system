// lib/registration/field-fsm.ts — [A] Deterministic dialogue state machine for registration
// FSM guarantees field order, confirm-before-accept, and no-assumptions rules.

import type { LanguageCode } from '@/lib/contracts/voice';
import type { VoiceSession } from '@/lib/contracts/voice';
import {
  FIELD_ORDER,
  VOICE_FIELD_ORDER,
  validateField,
  deriveAgeFromDOB,
  isSkipIntent,
  isYes,
  isNo,
  type FieldName,
  type FieldSpec,
} from './field-specs';
import { getPrompts, getFieldLabel } from '@/lib/voice/i18n';

// ─── Types ─────────────────────────────────────────────────────────────────────

export type FSMState =
  | 'IDLE'
  | 'CONSENT'
  | 'GREETING'
  | 'COLLECT_FIELD'
  | 'CONFIRM_FIELD'
  | 'MANUAL_FALLBACK'
  | 'NEXT_OR_SAVE'
  | 'SAVE_PATIENT'
  | 'SAVE_ERROR'
  | 'DONE';

export interface FormData {
  hospital: string;        // org slug (for save) — NOT displayed
  hospital_name: string;   // org name (for display)
  org_id: string;          // org UUID (for RegistrationResult)
  full_name: string;
  phone: string;
  email: string;
  date_of_birth: string;
  age: string;
  gender: string;
  blood_group: string;
  department: string;
  address: string;
  emergency_contact_name: string;
  emergency_contact_phone: string;
}

export interface OrgOption {
  id: string;
  name: string;
  slug: string;
  address: string | null;
}

export interface FSMContext {
  state: FSMState;
  currentFieldIndex: number;
  formData: FormData;
  retries: number;
  pendingValue: string;
  organisations: OrgOption[];
  departments: string[];
  error: string;
  transcriptLog: Array<{ role: 'assistant' | 'user'; text: string }>;
  isListening: boolean;
  isSpeaking: boolean;
  isProcessing: boolean;
}

export type FSMEvent =
  | { type: 'START' }
  | { type: 'CONSENT_GIVEN' }
  | { type: 'VOICE_INPUT'; text: string; confidence: number }
  | { type: 'MANUAL_INPUT'; field: FieldName; value: string }
  | { type: 'SAVE_SUCCESS'; patientId: string }
  | { type: 'SAVE_FAILURE'; error: string }
  | { type: 'SKIP' }
  | { type: 'FALLBACK_COMPLETE'; field: FieldName; value: string };

export function createInitialContext(): FSMContext {
  return {
    state: 'IDLE',
    currentFieldIndex: 0,
    formData: {
      hospital: '',
      hospital_name: '',
      org_id: '',
      full_name: '',
      phone: '',
      email: '',
      date_of_birth: '',
      age: '',
      gender: 'Male',
      blood_group: '',
      department: 'General',
      address: '',
      emergency_contact_name: '',
      emergency_contact_phone: '',
    },
    retries: 0,
    pendingValue: '',
    organisations: [],
    departments: [],
    error: '',
    transcriptLog: [],
    isListening: false,
    isSpeaking: false,
    isProcessing: false,
  };
}

// ─── FSM Controller ────────────────────────────────────────────────────────────

/**
 * The FSM controller runs the voice registration flow.
 * It is called by the React component and manages all dialogue state transitions.
 */
export class RegistrationFSM {
  private ctx: FSMContext;
  private session: VoiceSession;
  private onUpdate: (ctx: FSMContext) => void;
  private aborted: boolean = false;

  constructor(
    session: VoiceSession,
    organisations: OrgOption[],
    onUpdate: (ctx: FSMContext) => void,
    onComplete: (data: any, patientId: string, setupLink?: string) => void,
    fetchDepartments: (orgId: string) => Promise<string[]>,
  ) {
    this.ctx = createInitialContext();
    this.ctx.organisations = organisations;
    this.session = session;
    this.onUpdate = onUpdate;
    this.onComplete = onComplete;
    this.fetchDepartments = fetchDepartments;
  }

  abort() {
    this.aborted = true;
    // Immediately stop any in-progress speech
    import('@/lib/voice/tts').then(m => m.stopSpeaking());
  }

  private update(partial: Partial<FSMContext>) {
    Object.assign(this.ctx, partial);
    this.onUpdate({ ...this.ctx });
  }

  private log(role: 'assistant' | 'user', text: string) {
    this.ctx.transcriptLog.push({ role, text });
  }

  private async speak(text: string) {
    if (this.aborted) return; // Don't speak if aborted
    this.log('assistant', text);
    this.update({ isSpeaking: true });
    await this.session.speak(text);
    this.update({ isSpeaking: false });
  }

  private async listen(expectedType?: 'boolean' | 'text'): Promise<{ text: string; confidence: number }> {
    this.update({ isListening: true });
    const result = await this.session.listen(expectedType);
    if (result.text) this.log('user', result.text);
    this.update({ isListening: false });
    return result;
  }

  private getCurrentField(): FieldSpec | undefined {
    return VOICE_FIELD_ORDER[this.ctx.currentFieldIndex];
  }

  // ─── Main Flow ─────────────────────────────────────────────────────────────

  async start() {
    const prompts = getPrompts(this.session.language);

    // Consent
    this.update({ state: 'CONSENT' });
    await this.speak(prompts.consent);
    
    let consentRetries = 0;
    while (consentRetries <= 2 && !this.aborted) {
      const consentResult = await this.listen('boolean');
      if (this.aborted) return;

      if (isYes(consentResult.text)) {
        break; // user consented
      } else if (!consentResult.text) {
        consentRetries++;
        if (consentRetries <= 2) {
          await this.speak(prompts.reask);
          continue;
        }
      }

      // If it's a hard "no" or we ran out of retries, abort to manual
      await this.speak(this.session.language === 'hi' 
        ? 'कोई बात नहीं। आप स्क्रीन पर फॉर्म भर सकते हैं।'
        : 'No problem. You can fill the form on screen instead.');
      return;
    }

    // Greeting
    this.update({ state: 'GREETING' });
    await this.speak(prompts.greeting);

    // Start collecting fields
    await this.collectFields();
  }

  private async collectFields() {
    while (this.ctx.currentFieldIndex < VOICE_FIELD_ORDER.length && !this.aborted) {
      const field = this.getCurrentField()!;

      // Skip age if it was already autofilled by date of birth
      if (field.name === 'age' && this.ctx.formData.age) {
        this.update({ currentFieldIndex: this.ctx.currentFieldIndex + 1, retries: 0 });
        continue;
      }

      this.update({ state: 'COLLECT_FIELD', retries: 0 });
      const success = await this.collectSingleField(field);
      
      if (this.aborted) return;
      if (!success) {
        // Manual fallback was offered
        this.update({ state: 'MANUAL_FALLBACK' });
        return; // Wait for manual input from UI
      }

      // Autofill age if we just collected date_of_birth
      if (field.name === 'date_of_birth' && this.ctx.formData.date_of_birth) {
        const date = new Date(this.ctx.formData.date_of_birth);
        if (!isNaN(date.getTime())) {
          const ageYears = Math.floor((Date.now() - date.getTime()) / (365.25 * 24 * 3600 * 1000));
          this.ctx.formData.age = ageYears.toString();
          this.update({ formData: { ...this.ctx.formData } });
        }
      }

      this.update({ currentFieldIndex: this.ctx.currentFieldIndex + 1, retries: 0 });
    }

    if (!this.aborted) {
      this.update({ state: 'NEXT_OR_SAVE' });
      await this.savePatient();
    }
  }

  private async collectSingleField(field: FieldSpec): Promise<boolean> {
    const prompts = getPrompts(this.session.language);
    const fieldLabel = getFieldLabel(this.session.language, field.name);
    let retries = 0;

    // Build the prompt
    let promptText = prompts.field[field.name] || `Please provide your ${fieldLabel}.`;

    // For list/enum fields, append options
    if (field.type === 'list' && field.name === 'hospital') {
      const orgNames = this.ctx.organisations.map(o => o.name);
      promptText += ' ' + prompts.selectFromList(orgNames);
    } else if (field.type === 'list' && field.name === 'department') {
      // Fetch departments for the selected org
      if (this.ctx.formData.org_id) {
        this.update({ isProcessing: true });
        const deps = await this.fetchDepartments(this.ctx.formData.org_id);
        this.update({ isProcessing: false, departments: deps });
        if (deps.length > 0) {
          promptText += ' ' + prompts.selectFromList(deps);
        } else {
          // Fallback to the manual form's hardcoded departments
          const fallbackDeps = ['General', 'Cardiology', 'Orthopedics', 'Neurology', 'Pediatrics', 'Gynecology', 'Dermatology', 'ENT', 'Ophthalmology', 'Psychiatry', 'Oncology', 'Urology'];
          this.update({ departments: fallbackDeps });
          promptText += ' ' + prompts.selectFromList(fallbackDeps);
        }
      }
    } else if (field.type === 'enum' && field.enumValues) {
      promptText += ' ' + prompts.selectFromList(field.enumValues);
    }

    await this.speak(promptText);

    while (retries <= field.maxRetries && !this.aborted) {
      const result = await this.listen();
      if (this.aborted) return false;

      // Empty input
      if (!result.text) {
        retries++;
        if (retries > field.maxRetries) {
          await this.speak(prompts.fallbackOffer);
          return false; // Trigger manual fallback
        }
        await this.speak(prompts.reask);
        continue;
      }

      // Skip intent for optional fields
      if (field.skippable && isSkipIntent(result.text)) {
        this.setFieldValue(field.name, '');
        await this.speak(prompts.confirmed);
        return true;
      }

      // Validate the input
      const listOptions = field.name === 'hospital'
        ? this.ctx.organisations.map(o => o.name)
        : field.name === 'department'
          ? this.ctx.departments
          : undefined;

      const validation = validateField(field.name, result.text, {
        enumValues: field.enumValues,
        listOptions,
      });

      if (!validation.valid) {
        retries++;
        if (retries > field.maxRetries) {
          await this.speak(prompts.fallbackOffer);
          return false;
        }
        // Give specific error feedback
        if (field.type === 'list' || field.type === 'enum') {
          const options = listOptions || field.enumValues || [];
          await this.speak(prompts.noMatchRetry(options));
        } else if (field.voiceHostile) {
          await this.speak(prompts.spellItPrompt);
        } else {
          await this.speak(`${validation.error}. ${prompts.reask}`);
        }
        continue;
      }

      // Implicit Trust: We no longer ask "Is that correct?"
      // We directly save it to the form and move to the next field.
      this.setFieldValue(field.name, validation.cleaned);
      
      // Update transcript log with cleaned value to look nice in the UI
      if (validation.cleaned && validation.cleaned !== result.text) {
        for (let i = this.ctx.transcriptLog.length - 1; i >= 0; i--) {
          if (this.ctx.transcriptLog[i].role === 'user' && this.ctx.transcriptLog[i].text === result.text) {
            this.ctx.transcriptLog[i].text = validation.cleaned;
            this.update({ transcriptLog: [...this.ctx.transcriptLog] });
            break;
          }
        }
      }

      // Short acknowledgment
      await this.speak(prompts.confirmed);

      // If hospital was just set, store the org details for departments
      if (field.name === 'hospital') {
        const org = this.ctx.organisations.find(
          o => o.name.toLowerCase() === validation.cleaned.toLowerCase()
        );
        if (org) {
          this.ctx.formData.hospital = org.slug;
          this.ctx.formData.hospital_name = org.name;
          this.ctx.formData.org_id = org.id;
          this.session.set('organisationId', org.id);
          this.session.set('orgSlug', org.slug);
        }
      }

      return true;
    }

    return false;
  }

  private setFieldValue(name: FieldName, value: string) {
    if (name === 'hospital') {
      // hospital_name is set, but we store the matched name for display
      // The slug/id are stored separately in the org matching step
    } else {
      (this.ctx.formData as any)[name] = value;
    }
    this.update({ formData: { ...this.ctx.formData } });
  }

  // ─── Save ──────────────────────────────────────────────────────────────────

  private async savePatient() {
    // Validate required fields before attempting to save
    const missingRequired = VOICE_FIELD_ORDER.filter(f => !f.skippable && !this.ctx.formData[f.name]);
    if (missingRequired.length > 0) {
      const msg = this.session.language === 'hi'
        ? 'कुछ आवश्यक फ़ील्ड छूट गए हैं। कृपया उन्हें सबमिट करने के लिए स्क्रीन पर भरें।'
        : 'Some required fields are missing. Please fill them on the screen to submit.';
      this.update({ state: 'SAVE_ERROR', error: msg, isProcessing: false });
      await this.speak(msg);
      return;
    }

    const prompts = getPrompts(this.session.language);
    await this.speak(prompts.allFieldsDone);
    this.update({ state: 'SAVE_PATIENT', isProcessing: true });
    await this.speak(prompts.savingPatient);

    try {
      const payload = {
        org_slug: this.ctx.formData.hospital,
        full_name: this.ctx.formData.full_name,
        phone: this.ctx.formData.phone,
        email: this.ctx.formData.email || '',
        age: this.ctx.formData.age || '',
        gender: this.ctx.formData.gender || 'Male',
        date_of_birth: this.ctx.formData.date_of_birth || '',
        address: this.ctx.formData.address || '',
        blood_group: this.ctx.formData.blood_group || '',
        department: this.ctx.formData.department || 'General',
        emergency_contact_name: this.ctx.formData.emergency_contact_name || '',
        emergency_contact_phone: this.ctx.formData.emergency_contact_phone || '',
      };

      const res = await fetch('/api/patient/self-register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (data.success) {
        this.update({ state: 'DONE', isProcessing: false });
        await this.speak(prompts.saveSuccess(data.patient_id));
        this.onComplete(this.ctx.formData, data.patient_id, data.setup_link);
      } else {
        this.update({ state: 'SAVE_ERROR', error: data.error || 'Save failed', isProcessing: false });
        await this.speak(prompts.saveError);
      }
    } catch (err: any) {
      this.update({ state: 'SAVE_ERROR', error: err.message || 'Network error', isProcessing: false });
      await this.speak(getPrompts(this.session.language).saveError);
    }
  }

  // ─── External triggers (for manual input from UI) ──────────────────────────

  /**
   * Handle manual input from the on-screen form for a specific field.
   * Called when the user taps/types a correction.
   */
  async handleManualInput(field: FieldName, value: string) {
    // Unconditionally update the form data so the React input component can reflect keystrokes
    (this.ctx.formData as any)[field] = value;
    this.update({ formData: { ...this.ctx.formData } });

    // If it happens to be valid, we can process side-effects (like hospital selection)
    const validation = validateField(field, value, {
      enumValues: FIELD_ORDER.find(f => f.name === field)?.enumValues,
      listOptions: field === 'hospital'
        ? this.ctx.organisations.map(o => o.name)
        : field === 'department'
          ? this.ctx.departments
          : undefined,
    });

    if (validation.valid) {
      if (field === 'hospital') {
        const org = this.ctx.organisations.find(
          o => o.name.toLowerCase() === validation.cleaned.toLowerCase() || o.slug === value
        );
        if (org) {
          this.ctx.formData.hospital = org.slug;
          this.ctx.formData.hospital_name = org.name;
          this.ctx.formData.org_id = org.id;
          this.session.set('organisationId', org.id);
          this.session.set('orgSlug', org.slug);
          this.update({ formData: { ...this.ctx.formData } });
        }
      }
    }
  }

  /**
   * Resume after manual fallback.
   */
  async resumeAfterFallback() {
    const fieldSpec = this.getCurrentField()!;
    const currentValue = (this.ctx.formData as any)[fieldSpec.name] || '';
    
    const validation = validateField(fieldSpec.name, currentValue, {
      enumValues: fieldSpec.enumValues,
      listOptions: fieldSpec.name === 'hospital'
        ? this.ctx.organisations.map(o => o.name)
        : fieldSpec.name === 'department'
          ? this.ctx.departments
          : undefined,
    });

    if (!validation.valid) {
      // Speak the error and refuse to proceed
      await this.speak(validation.error || 'Invalid input.');
      return;
    }

    // Save cleaned value and proceed
    (this.ctx.formData as any)[fieldSpec.name] = validation.cleaned;
    this.update({ 
      formData: { ...this.ctx.formData },
      currentFieldIndex: this.ctx.currentFieldIndex + 1, 
      retries: 0 
    });
    
    await this.collectFields();
  }

  /**
   * Submit the form manually (if voice save failed).
   */
  async submitManually() {
    await this.savePatient();
  }

  getContext(): FSMContext {
    return { ...this.ctx };
  }
}
