/**
 * Normalises a phone number to E.164. Pakistani local formats (03xx..., 3xx..., 92...) are
 * converted; any other country must be supplied as +<country code><number>.
 * Returns null when the input is not a plausible number.
 */
export function normalizePhone(input: string): string | null {
  const raw = input.trim().replace(/[\s\-().]/g, '');
  if (!/^\+?\d+$/.test(raw)) return null;
  let e164: string;
  if (raw.startsWith('+')) e164 = raw;
  else if (raw.startsWith('0092')) e164 = `+${raw.slice(2)}`;
  else if (raw.startsWith('92') && raw.length === 12) e164 = `+${raw}`;
  else if (raw.startsWith('03') && raw.length === 11) e164 = `+92${raw.slice(1)}`;
  else if (raw.startsWith('3') && raw.length === 10) e164 = `+92${raw}`;
  else return null;
  if (!/^\+[1-9]\d{7,14}$/.test(e164)) return null;
  if (e164.startsWith('+92') && !/^\+923\d{9}$/.test(e164)) return null; // Pakistani mobile numbers only
  return e164;
}
