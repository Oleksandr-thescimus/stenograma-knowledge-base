import { readFileSync } from 'node:fs';
import type { ActionItem, AssistantAnswer, Session, SessionBundle, StenogramaMessage, Transcript } from './types.ts';

// data.json of the extension's backup ZIP (its helpers/backup.ts). `unzip -p backup.zip data.json > data.json` gets it
// without the audio
interface BackupData {
  format: 'stenograma-backup';
  version: number;
  sessions: (Session & { recording?: { diagnostics?: unknown } })[];
  transcripts: Transcript[];
  assistantAnswers: (AssistantAnswer & { request?: unknown })[];
  actionItems: ActionItem[];
}

export const readBackup = (path: string): BackupData => {
  const data = JSON.parse(readFileSync(path, 'utf8')) as BackupData;

  if (data.format !== 'stenograma-backup' || !Array.isArray(data.sessions)) {
    throw new Error(`${path} isn't data.json of a Stenograma backup`);
  }

  return data;
};

const withoutIcon = ({ userIconUrl: _icon, ...message }: StenogramaMessage & { userIconUrl?: string }) => message;

// The backup's sessions as bundles, like a push's: never the prompts (request), recording diagnostics, user icons,
// audio or pending utterances (F1)
export const bundlesFromBackup = (data: BackupData): SessionBundle[] => data.sessions.map((session) => {
  const { recording, ...rest } = session;
  const of = <T extends { sessionId: string }>(rows: T[]) => rows.filter((row) => row.sessionId === session.sessionId);

  return {
    session: {
      ...rest,
      ...(recording && { recording: { ...recording, diagnostics: undefined } }),
      stenogramaArray: session.stenogramaArray.map(withoutIcon),
    },
    transcripts: of(data.transcripts ?? []).filter((transcript) => transcript.status === 'done')
      .map((transcript) => ({ ...transcript, messages: transcript.messages.map(withoutIcon) })),
    assistantAnswers: of(data.assistantAnswers ?? []).map(({ request: _request, ...answer }) => answer),
    actionItems: of(data.actionItems ?? []),
  };
});
