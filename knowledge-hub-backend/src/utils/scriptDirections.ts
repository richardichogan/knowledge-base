export const SCRIPT_DIRECTION_LIMIT = 4000;

export function parseScriptDirection(value: unknown): string {
  if (typeof value !== 'string' || value.length > SCRIPT_DIRECTION_LIMIT) {
    throw new Error(`Presenter directions must be text of at most ${SCRIPT_DIRECTION_LIMIT} characters.`);
  }
  return value;
}
