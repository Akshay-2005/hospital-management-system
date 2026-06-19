/**
 * app/patient/appointment/voice/page.tsx
 * =====================================================================
 * Server Component wrapper for the Voice Booking page.
 * This isolates the 'use client' boundary and ensures useSearchParams()
 * is safely wrapped in <Suspense> during SSR, preventing hydration errors.
 * =====================================================================
 */

import { prisma } from '@/backend/db';
import VoiceBookingClient from './VoiceBookingClient';

export const metadata = {
  title: 'AI Voice Booking | HospitalOS',
  description: 'Book your appointment using our AI voice assistant.',
};

export default async function VoiceBookingPage() {
  const org = await prisma.organization.findFirst({
    where: { is_active: true }
  });
  
  const orgId = org?.id || 'org-avani-default';
  
  return <VoiceBookingClient initialOrgId={orgId} />;
}
