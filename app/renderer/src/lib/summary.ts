import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppEvent, MeetingView, ShortSummary } from '../../../../core/protocol';
import { errorMessage, useKbEvents } from '@/lib/kb';

// "Summarize" in the meeting view: the kept short summary, and one being made, streamed. Closing the view or opening
// another meeting stops it

export interface SummaryRun {
  id: string;
  text: string;
  // Calls done of all those needed; more than one for a meeting summarized in parts
  done: number;
  all: number;
  llm: string | null;
  // Where it runs, by its name: "orangepi"
  server?: string;
  startedAt: number;
}

// After this long a long meeting is still in parts: Gemini would take it whole
const SLOW_MS = 60_000;

export const useMeetingSummary = (meeting: MeetingView | null | undefined) => {
  // One made in this view; else the meeting's own, at once, so the header has its height before the view scrolls to the
  // cited moment
  const [made, setMade] = useState<{ meeting: MeetingView, summary: ShortSummary } | null>(null);
  const [run, setRun] = useState<SummaryRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  // Set at once, as the core's first events may come before a render
  const runId = useRef<string | null>(null);
  const meetingRef = useRef(meeting);
  meetingRef.current = meeting;

  const finish = () => {
    runId.current = null;
    setRun(null);
  };

  useEffect(() => {
    setError(null);

    return () => {
      if (runId.current) {
        window.kb.invoke('cancelSummary', { summaryId: runId.current }).catch(() => undefined);
      }

      finish();
    };
  }, [meeting]);

  const onEvent = useCallback((event: AppEvent) => {
    if (event.type !== 'summary' || event.summaryId !== runId.current) {
      return;
    }

    const { part } = event;

    switch (part.kind) {
      case 'progress':
        setRun((current) => current && { ...current, done: part.done, all: part.all, llm: part.llm, server: part.server });
        break;
      case 'text':
        setRun((current) => current && { ...current, text: current.text + part.text });
        break;
      case 'done':
        setMade(meetingRef.current ? { meeting: meetingRef.current, summary: part.summary } : null);
        finish();
        break;
      case 'stopped':
        finish();
        break;
      default:
        setError(part.message);
        finish();
    }
  }, []);

  useKbEvents(onEvent);

  const running = Boolean(run);

  useEffect(() => {
    if (!running) {
      return undefined;
    }

    const timer = setInterval(() => setNow(Date.now()), 5000);

    return () => clearInterval(timer);
  }, [running]);

  const start = () => {
    if (!meeting || runId.current) {
      return;
    }

    const id = crypto.randomUUID();
    runId.current = id;
    setError(null);
    setNow(Date.now());
    setRun({ id, text: '', done: 0, all: 1, llm: null, startedAt: Date.now() });
    window.kb.invoke('summarize', { summaryId: id, sourceId: meeting.sourceId, sessionId: meeting.sessionId }).catch((reason: unknown) => {
      setError(errorMessage(reason));
      finish();
    });
  };

  const stop = () => {
    if (runId.current) {
      window.kb.invoke('cancelSummary', { summaryId: runId.current }).catch(() => undefined);
    }
  };

  const saved = (made && made.meeting === meeting ? made.summary : null) ?? meeting?.shortSummary ?? null;
  const slow = Boolean(run && now - run.startedAt > SLOW_MS && !run.llm?.startsWith('gemini'));

  return { saved, run, error, slow, start, stop };
};
