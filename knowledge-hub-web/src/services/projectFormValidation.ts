export function parseExpectedOutputs(text: string): string[] {
  return text.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

export function validateProjectContext(input: { goal: string; role: string; ownership: string }): string | null {
  for (const [value, label, limit] of [
    [input.goal, 'Goal', 2000],
    [input.role, 'Your role', 200],
    [input.ownership, 'Ownership', 200],
  ] as const) {
    if (value.trim().length > limit) return `${label} must be at most ${limit} characters. Your text has not been changed.`;
  }
  return null;
}
