/**
 * Contact details come from the registration form as typed, so a phone field
 * can hold "contacteer Thomas" and an e-mail field `////`. Those are shown as
 * they are; only real numbers and addresses get a call or mail link.
 */

export function phoneHref(phone: string): string | null {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, '');
  return /^\+?[\d\s()./-]+$/.test(trimmed) && digits.length >= 6 ? `tel:${trimmed.replace(/[^\d+]/g, '')}` : null;
}

export function mailHref(email: string): string | null {
  const trimmed = email.trim();
  return /^[^\s@]+@[^\s@]+$/.test(trimmed) ? `mailto:${trimmed}` : null;
}
