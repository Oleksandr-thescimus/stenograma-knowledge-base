import { useEffect, useState } from 'react';
import { Loader2, Wand2 } from 'lucide-react';
import type { DraftLearning } from '../../../../core/protocol';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage } from '@/lib/kb';

// The user's style for reply drafts (Settings → Chats): its description, made by a model from their messages and
// edited here (saved with Save), and what else the drafts learn it from: their replies to similar messages and the
// drafts they rewrote before sending

const learningText = ({ replies, answered, asWritten }: DraftLearning) => [
  `Each draft also follows a few of your ${replies.toLocaleString()} replies, those to the most similar messages, and the last drafts you rewrote before sending.`,
  answered > 0 && `Of the ${answered.toLocaleString()} drafts you answered, ${asWritten.toLocaleString()} were sent as written.`,
].filter(Boolean).join(' ');

const DraftStyleField = ({ value, onChange }: { value: string, onChange: (style: string) => void }) => {
  const [learning, setLearning] = useState<DraftLearning | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.kb.invoke('draftLearning', {}).then(setLearning).catch(() => setLearning(null));
  }, []);

  const describe = async () => {
    setBusy(true);
    setError(null);

    try {
      onChange(await window.kb.invoke('describeStyle', {}));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Label htmlFor="draft-style" className="flex-1">Your style</Label>
        <Button size="sm" variant="outline" onClick={describe} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Wand2 />}
          {busy ? 'Reading your messages…' : 'Describe my style'}
        </Button>
      </div>
      <Textarea
        id="draft-style"
        rows={6}
        value={value}
        placeholder="How you write, for the drafts: e.g. short, no greetings, informal, Ukrainian with English terms. &quot;Describe my style&quot; writes it from your messages."
        onChange={(event) => onChange(event.target.value)}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <p className="text-xs text-muted-foreground">
        A model reads your latest messages and describes them; edit it as you like, then Save.
        {learning && ` ${learningText(learning)}`}
      </p>
    </div>
  );
};

export default DraftStyleField;
