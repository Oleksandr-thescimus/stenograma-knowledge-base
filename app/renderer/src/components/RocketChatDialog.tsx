import { useEffect, useState } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import type { ChatRoomChoice, RoomSelection, SyncLimits } from '../../../../core/protocol';
import RoomSelector, { isSelectionEmpty } from '@/components/RoomSelector';
import { SourceIcon } from '@/components/SourceIcon';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatDay } from '@/lib/format';
import { errorMessage } from '@/lib/kb';

// Rocket.Chat as a source (F3), with a Personal Access Token: added in two steps (the token, then the rooms and the
// period read), and changed later: other rooms, another period. A new token, when the old one is refused, has a dialog
// of its own, RocketChatTokenDialog: the rooms can't be listed with the old one

const PERIODS = [
  { value: '1', label: 'The last month' },
  { value: '3', label: 'The last 3 months' },
  { value: '6', label: 'The last 6 months' },
  { value: '12', label: 'The last 12 months' },
  { value: 'all', label: 'Everything' },
];

const sinceOf = (period: string) => {
  if (period === 'all') {
    return 0;
  }

  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setMonth(date.getMonth() - Number(period));

  return date.getTime();
};

const DEFAULT_SELECTION: RoomSelection = { mode: 'chosen', ids: [] };
// As the core's DEFAULT_LIMITS: half the calls Rocket.Chat allows from an address, and a pause between files
const DEFAULT_LIMITS: SyncLimits = { intervalMinutes: 5, requestsPerMinute: 5, filePauseSeconds: 3 };
const INTERVALS = [5, 15, 30, 60];
const PAUSES = [0, 1, 3, 10, 30];

// How hard the source may work the chat's server
const LimitsFields = ({ limits, onChange }: { limits: SyncLimits, onChange: (limits: SyncLimits) => void }) => (
  <details className="rounded-md border px-3 py-2">
    <summary className="cursor-pointer text-sm">
      Load on the server: live, else every {limits.intervalMinutes} min, at most {limits.requestsPerMinute} calls a minute, {limits.filePauseSeconds} s between files
    </summary>
    {/* The fields on one line, whatever their labels' length */}
    <div className="mt-3 grid gap-3 sm:grid-cols-3">
      <div className="flex flex-col justify-end gap-1">
        <Label title="While the realtime connection is up, new messages arrive as they're sent and the whole sync runs every 30 minutes">Sync every, not live</Label>
        <Select value={String(limits.intervalMinutes)} onValueChange={(value) => onChange({ ...limits, intervalMinutes: Number(value) })}>
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            {INTERVALS.map((minutes) => <SelectItem key={minutes} value={String(minutes)}>{minutes} minutes</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col justify-end gap-1">
        <Label htmlFor="rc-rpm">Calls a minute, each kind</Label>
        <Input
          id="rc-rpm"
          type="number"
          min={1}
          max={30}
          value={limits.requestsPerMinute}
          onChange={(event) => onChange({ ...limits, requestsPerMinute: Math.min(30, Math.max(1, Math.round(Number(event.target.value) || 1))) })}
        />
      </div>
      <div className="flex flex-col justify-end gap-1">
        <Label>Pause between files</Label>
        <Select value={String(limits.filePauseSeconds)} onValueChange={(value) => onChange({ ...limits, filePauseSeconds: Number(value) })}>
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            {PAUSES.map((seconds) => <SelectItem key={seconds} value={String(seconds)}>{seconds ? `${seconds} s` : 'None'}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
    </div>
    <p className="mt-2 text-xs text-muted-foreground">
      Live: Rocket.Chat&apos;s realtime connection tells which rooms got a new message, and only those are read, at once; the
      whole sync then runs every 30 minutes. Without it (not reached, or cut), every {limits.intervalMinutes} minutes.
      The calls a minute count every read, the live ones too: more rooms changed in a minute wait for the next one.
      Rocket.Chat allows 10 calls a minute of each kind from an address by default, shared by everyone on the same
      network: staying below leaves room for colleagues. A first read takes about a minute per 5 rooms or 5,000 messages.
    </p>
  </details>
);

interface RocketChatDialogProps {
  open: boolean;
  // Edits this source; without it, adds one
  sourceId?: number;
  onClose: () => void;
  // Back to "Add a source"
  onBack?: () => void;
}

const TOKEN_HELP = 'In Rocket.Chat: your avatar → My Account → Personal Access Tokens. Add one with "Ignore Two Factor Authentication" ticked; it shows the token and your user ID once. The token stays in the system keyring.';

const RocketChatDialog = ({ open, sourceId, onClose, onBack }: RocketChatDialogProps) => {
  const editing = sourceId !== undefined;
  const [serverUrl, setServerUrl] = useState('https://');
  const [userId, setUserId] = useState('');
  const [token, setToken] = useState('');
  const [user, setUser] = useState<string | null>(null);
  const [rooms, setRooms] = useState<ChatRoomChoice[] | null>(null);
  const [selection, setSelection] = useState<RoomSelection>(DEFAULT_SELECTION);
  const [period, setPeriod] = useState('12');
  const [limits, setLimits] = useState<SyncLimits>(DEFAULT_LIMITS);
  // The period read now, while editing
  const [since, setSince] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || sourceId === undefined) {
      return undefined;
    }

    let alive = true;
    setBusy(true);
    window.kb.invoke('rocketChatRooms', { sourceId })
      .then((setup) => {
        if (alive) {
          setRooms(setup.rooms);
          setSelection(setup.selection);
          setSince(setup.since);
          setLimits(setup.limits);
          setPeriod('keep');
        }
      })
      .catch((reason: unknown) => alive && setError(errorMessage(reason)))
      .finally(() => alive && setBusy(false));

    return () => {
      alive = false;
    };
  }, [open, sourceId]);

  const close = () => {
    setToken('');
    setUser(null);
    setRooms(null);
    setSelection(DEFAULT_SELECTION);
    setPeriod('12');
    setLimits(DEFAULT_LIMITS);
    setSince(null);
    setError(null);
    onClose();
  };

  const run = async (step: () => Promise<void>) => {
    setBusy(true);
    setError(null);

    try {
      await step();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const check = () => run(async () => {
    const found = await window.kb.invoke('rocketChatCheck', { serverUrl: serverUrl.trim(), userId: userId.trim(), token: token.trim() });
    setUser(found.user);
    setRooms(found.rooms);
  });

  const periodSince = () => (period === 'keep' && since !== null ? since : sinceOf(period));

  const save = () => run(async () => {
    if (editing) {
      await window.kb.invoke('updateRocketChat', { sourceId, selection, since: periodSince(), limits });
    } else {
      await window.kb.invoke('addRocketChat', {
        serverUrl: serverUrl.trim(), userId: userId.trim(), token: token.trim(), selection, since: periodSince(), limits,
      });
    }

    close();
  });

  const accessStep = !editing && !rooms;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      {/* One column as wide as the dialog: else a long room name, which doesn't wrap, widens it past the dialog */}
      <DialogContent className="max-w-xl grid-cols-1 sm:max-w-xl">
        <DialogHeader className="flex-row items-center gap-3 space-y-0">
          <SourceIcon source={{ kind: 'rocketchat', browser: null }} />
          <div className="min-w-0 space-y-1">
            <DialogTitle>{editing ? 'Rocket.Chat: rooms and period' : 'Add Rocket.Chat'}</DialogTitle>
            <DialogDescription>
              {accessStep
                ? TOKEN_HELP
                : user ?? `New messages arrive as they're sent, over Rocket.Chat's realtime connection, or every ${limits.intervalMinutes} minutes without it. They go to cloud AI only once "May go to cloud AI" is on.`}
            </DialogDescription>
          </div>
        </DialogHeader>
        {accessStep ? (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="rc-server">Server</Label>
              <Input id="rc-server" value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="https://chat.example.com" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="rc-user">User ID</Label>
              <Input id="rc-user" value={userId} onChange={(event) => setUserId(event.target.value)} className="font-mono text-xs" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="rc-token">Token</Label>
              <Input id="rc-token" type="password" value={token} onChange={(event) => setToken(event.target.value)} className="font-mono text-xs" />
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {rooms ? <RoomSelector rooms={rooms} selection={selection} onChange={setSelection} /> : busy && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Listing your rooms…
              </p>
            )}
            <div className="space-y-1">
              <Label>Read messages from</Label>
              <Select value={period} onValueChange={setPeriod}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {editing && since !== null && <SelectItem value="keep">{since ? `${formatDay(since)}, as now` : 'Everything, as now'}</SelectItem>}
                  {/* "Everything" is the kept one when it's everything already */}
                  {PERIODS.filter(({ value }) => !(editing && since === 0 && value === 'all'))
                    .map(({ value, label }) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
                </SelectContent>
              </Select>
              {editing && since !== null && periodSince() !== since && (
                <p className="text-xs text-muted-foreground">
                  {periodSince() < since ? 'The rooms are read again from the new start.' : 'Messages before the new start are removed.'}
                </p>
              )}
            </div>
            <LimitsFields limits={limits} onChange={setLimits} />
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          {accessStep && onBack && (
            <Button variant="ghost" className="sm:mr-auto" onClick={onBack}>
              <ArrowLeft />
              Back
            </Button>
          )}
          <Button variant="ghost" onClick={close}>Cancel</Button>
          {accessStep ? (
            <Button onClick={check} disabled={busy || !serverUrl.trim() || !userId.trim() || !token.trim()}>
              {busy && <Loader2 className="animate-spin" />}
              Next
            </Button>
          ) : (
            <Button onClick={save} disabled={busy || !rooms || isSelectionEmpty(selection)}>
              {busy && rooms && <Loader2 className="animate-spin" />}
              {editing ? 'Save' : 'Add'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// A new token for a source whose token is refused or missing, as its card's error offers it
export const RocketChatTokenDialog = ({ sourceId, onClose }: { sourceId: number | null, onClose: () => void }) => {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setToken('');
    setError(null);
    onClose();
  };

  const save = async () => {
    if (sourceId !== null) {
      setBusy(true);
      setError(null);

      try {
        await window.kb.invoke('setRocketChatToken', { sourceId, token: token.trim() });
        close();
      } catch (reason) {
        setError(errorMessage(reason));
      } finally {
        setBusy(false);
      }
    }
  };

  return (
    <Dialog open={sourceId !== null} onOpenChange={(next) => !next && close()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader className="flex-row items-center gap-3 space-y-0">
          <SourceIcon source={{ kind: 'rocketchat', browser: null }} />
          <div className="min-w-0 space-y-1">
            <DialogTitle>Rocket.Chat: a new token</DialogTitle>
            <DialogDescription>{TOKEN_HELP}</DialogDescription>
          </div>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="rc-new-token">Token</Label>
          <Input
            id="rc-new-token"
            type="password"
            autoFocus
            value={token}
            onChange={(event) => setToken(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && token.trim() && save()}
            className="font-mono text-xs"
          />
          <p className="text-xs text-muted-foreground">It&apos;s checked with Rocket.Chat as your own, then the rooms are read again.</p>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button onClick={save} disabled={busy || !token.trim()}>
            {busy && <Loader2 className="animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default RocketChatDialog;
