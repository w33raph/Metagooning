export type ApplicationSession = {
  userId: string;
  guildId: string;
  questions: string[];
  answers: string[];
  currentIndex: number;
};

export function parseApplicationQuestions(input: string): string[] {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function createApplicationSession(questions: string[], userId = "", guildId = ""): ApplicationSession {
  return {
    userId,
    guildId,
    questions,
    answers: [],
    currentIndex: 0,
  };
}

export function getCurrentQuestion(session: ApplicationSession): string | null {
  return session.questions[session.currentIndex] ?? null;
}

export function submitApplicationAnswer(session: ApplicationSession, answer: string): ApplicationSession {
  const nextAnswers = [...session.answers];
  nextAnswers[session.currentIndex] = answer.trim();

  return {
    ...session,
    answers: nextAnswers,
    currentIndex: session.currentIndex + 1,
  };
}

export function isApplicationComplete(session: ApplicationSession): boolean {
  return session.currentIndex >= session.questions.length;
}
