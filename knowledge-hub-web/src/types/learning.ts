export interface LearningSessionSummary {
  id: string; status: 'preparing' | 'ready' | 'failed'; error: string | null; createdAt: string;
  total: number; answered: number; skipped: number; correct: number; dailyFor: string | null;
}
export interface LearningTopicProgress {
  id: string; label: string; ecosystem: string; answered: number; correct: number; accuracy: number | null;
  recentAnswered: number; recentCorrect: number; recentAccuracy: number | null; lastAnsweredAt: string | null;
}
export interface LearningTopicHistory {
  answers: { sessionId: string; position: number; answeredAt: string; question: string; category: string; level: string;
    correct: boolean; withdrawn: boolean; chosenAnswer: string; correctAnswer: string }[];
  hasMore: boolean;
}
export interface LearningOverview {
  sessions: LearningSessionSummary[];
  topics: LearningTopicProgress[];
  daily: { id: string; status: LearningSessionSummary['status']; error: string | null; total: number; dailyFor: string }[];
  schedule: { time: string; timezone: string; nights: string; automatic: boolean };
}
export interface LearningSession {
  id: string; status: LearningSessionSummary['status']; error: string | null;
  questionCount: number; dailyFor: string | null; items: { position: number; answered: boolean; skipped: boolean }[];
}
export interface LearningEvidence { source: number; quote: string }
export interface LearningMessage { id: string; question: string; answer: string; evidence: LearningEvidence[]; checkedAt: string }
export type LearningQuestionView =
  | { blocked: true; position: number; reason: string; chosen: number | null; skipped: boolean }
  | { blocked: false; position: number; questionId: string; topic: string; category: string; level: string; ecosystem: string;
    question: string; options: string[]; chosen: number | null; skipped: boolean;
    sources: { url: string; title: string }[]; checkedAt: string;
    review: { correct: number; explanation: string; evidence: LearningEvidence[];
      options: { explanation: string; evidence: LearningEvidence[] }[] } | null; messages: LearningMessage[] };
