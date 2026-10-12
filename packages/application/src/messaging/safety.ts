/**
 * Non-blocking safety heuristics for chat. Messages are still delivered; the UI shows a notice
 * ("Pay through checkout so the purchase is recorded …") next to anything that looks like an attempt
 * to move payment or contact off the platform. False positives are acceptable; it is advice, not a block.
 */

export type SafetyReason = 'phone' | 'bank_details' | 'email' | 'off_platform';

export interface SafetyAssessment {
  flagged: boolean;
  reasons: SafetyReason[];
}

// Nigerian mobile numbers in common spellings: 0803 123 4567, +234 803-123-4567, 2348031234567.
const PHONE = /(?:\+?234|\b0)[\s.-]?[789][01](?:[\s.-]?\d){8}\b/;
// Ten-digit NUBAN account numbers (or any long digit run that could be one).
const ACCOUNT_DIGITS = /\b\d(?:[\s-]?\d){9,}\b/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const BANK_WORDS =
  /\b(account\s*(number|no\.?|num|details)|acct\s*(no\.?|number)?|bank\s*(details|transfer|account)|sort\s*code|opay|palmpay|moniepoint|kuda|gtbank|gtb|zenith\s*bank|access\s*bank|first\s*bank|uba|wema|sterling\s*bank|fidelity\s*bank|union\s*bank|ecobank|stanbic)\b/i;
const OFF_PLATFORM =
  /\b(whats\s*app|whatsapp|telegram|signal\s*app|dm\s*me|call\s*me|text\s*me|my\s*(number|line)\s*(is)?|pay\s*(me\s*)?(directly|outside|offline|cash|by\s*transfer)|send\s*(the\s*)?(money|payment|cash)|transfer\s*(the\s*)?(money|payment|to\s*me|directly)|outside\s*(the\s*)?(app|platform|site|website|checkout)|off\s*(the\s*)?(app|platform|site)|avoid\s*(the\s*)?(fees?|checkout))\b/i;

export function assessMessageSafety(body: string | null | undefined): SafetyAssessment {
  const text = (body ?? '').slice(0, 4000);
  if (!text.trim()) return { flagged: false, reasons: [] };
  const reasons: SafetyReason[] = [];
  if (PHONE.test(text)) reasons.push('phone');
  if (BANK_WORDS.test(text) || (!PHONE.test(text) && ACCOUNT_DIGITS.test(text))) reasons.push('bank_details');
  if (EMAIL.test(text)) reasons.push('email');
  if (OFF_PLATFORM.test(text)) reasons.push('off_platform');
  return { flagged: reasons.length > 0, reasons };
}

export const SAFETY_NOTICE =
  'Pay through checkout so the purchase is recorded with its order, delivery tracking and support. Never pay by direct bank transfer or move the conversation off Thrift Market.';

/** Normalises a body for duplicate-spam comparison (case, whitespace and punctuation-insensitive). */
export function spamFingerprint(body: string): string {
  return body
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, ' ')
    .trim();
}
