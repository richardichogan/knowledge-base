export const AUTOCUE_FONT_SIZE = { default: 64, min: 24, max: 96, step: 4 } as const;
export const AUTOCUE_FONT_KEY = 'autocue_font_size';
export const AUTOCUE_SENSITIVITY_KEY = 'autocue_sensitivity';

export function readAutocueSettings(storage: Pick<Storage, 'getItem'>, defaultSensitivity: number, override: string | null) {
  const errors: string[] = [];
  function setting(raw: string | null, fallback: number, min: number, max: number): number {
    if (raw === null) return fallback;
    const value = Number(raw);
    if (raw.trim() && Number.isFinite(value) && value >= min && value <= max) return value;
    errors.push('An invalid teleprompter setting was reset to its default.');
    return fallback;
  }
  return {
    fontSize: setting(storage.getItem(AUTOCUE_FONT_KEY), AUTOCUE_FONT_SIZE.default, AUTOCUE_FONT_SIZE.min, AUTOCUE_FONT_SIZE.max),
    sensitivity: setting(override ?? storage.getItem(AUTOCUE_SENSITIVITY_KEY), defaultSensitivity, 0.01, 0.3),
    error: errors.join(' '),
  };
}
