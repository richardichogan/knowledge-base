export interface PersonInput {
  name: string; emails: string[]; organisation: string; role: string; notes: string; threads: string;
  source: string; sourcePeriod: string; contactGroup: string; emailCount: number | null;
}
export interface Person extends PersonInput { id: string; createdAt: string; updatedAt: string }

export const EMPTY_PERSON: PersonInput = {
  name: '', emails: [], organisation: '', role: '', notes: '', threads: '',
  source: '', sourcePeriod: '', contactGroup: '', emailCount: null,
};
