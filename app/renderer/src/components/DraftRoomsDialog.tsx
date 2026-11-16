import { useEffect, useMemo, useState } from 'react';
import { Hash, Loader2, Lock } from 'lucide-react';
import type { DraftRoom } from '../../../../core/protocol';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { errorMessage } from '@/lib/kb';

// The rooms of a messenger source where every message from someone else gets a reply draft, not only those to the
// user: chosen among the rooms it reads, found by name. Direct messages always get theirs, so they aren't listed

const DraftRoomsDialog = ({ sourceId, open, onClose }: { sourceId: number, open: boolean, onClose: () => void }) => {
  const [rooms, setRooms] = useState<DraftRoom[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }

    setRooms(null);
    setQuery('');
    setError(null);
    window.kb.invoke('draftRooms', { sourceId })
      .then((found) => {
        setRooms(found);
        setChosen(new Set(found.filter((room) => room.all).map((room) => room.roomId)));
      })
      .catch((reason: unknown) => setError(errorMessage(reason)));
  }, [open, sourceId]);

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);

    // The chosen first, then by name
    return (rooms ?? []).filter((room) => words.every((word) => room.title.toLowerCase().includes(word)))
      .sort((a, b) => Number(chosen.has(b.roomId) && b.all) - Number(chosen.has(a.roomId) && a.all));
  }, [rooms, query, chosen]);

  const tick = (roomId: string, on: boolean) => setChosen((current) => {
    const next = new Set(current);

    if (on) {
      next.add(roomId);
    } else {
      next.delete(roomId);
    }

    return next;
  });

  const save = async () => {
    setSaving(true);

    try {
      await window.kb.invoke('setDraftRooms', { sourceId, roomIds: [...chosen] });
      onClose();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Drafts to every message</DialogTitle>
          <DialogDescription>
            In these rooms every message from someone else gets a reply draft, not only those to you, once its conversation has
            been quiet for 2 minutes: a burst gets one draft, for its last message. Direct messages always get theirs.
          </DialogDescription>
        </DialogHeader>
        {rooms === null && !error && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Listing the rooms…
          </p>
        )}
        {rooms && (
          <div className="space-y-2">
            <Input placeholder="Find a room" value={query} onChange={(event) => setQuery(event.target.value)} />
            <div className="max-h-72 overflow-y-auto rounded-md border">
              {shown.map((room) => {
                const Icon = room.type === 'group' ? Lock : Hash;

                return (
                  <Label key={room.roomId} className="flex cursor-pointer items-center gap-2 border-b px-3 py-2 font-normal last:border-b-0 hover:bg-accent">
                    <Checkbox checked={chosen.has(room.roomId)} onCheckedChange={(on) => tick(room.roomId, on === true)} />
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate" title={room.title}>{room.title}</span>
                  </Label>
                );
              })}
              {!shown.length && <p className="p-3 text-sm text-muted-foreground">{rooms.length ? 'No room matches.' : 'No rooms read yet.'}</p>}
            </div>
            <p className="text-xs text-muted-foreground">
              {chosen.size} chosen. A lively room means many drafts: each takes the background queue&apos;s time.
            </p>
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={!rooms || saving}>
            {saving && <Loader2 className="animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default DraftRoomsDialog;
