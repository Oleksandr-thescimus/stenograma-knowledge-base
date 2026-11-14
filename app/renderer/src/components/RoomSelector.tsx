import { useMemo, useState } from 'react';
import { Hash, Lock, User } from 'lucide-react';
import type { ChatRoomChoice, ChatRoomType, RoomSelection } from '../../../../core/protocol';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { formatDay, formatWhen } from '@/lib/format';

// The rooms a messenger source reads (F3): those chosen, or all the user is in of the types ticked, rooms joined later
// too. Chosen ones are found by name, the latest active first

const TYPES: { type: ChatRoomType, label: string, Icon: typeof Hash }[] = [
  { type: 'channel', label: 'Channels', Icon: Hash },
  { type: 'group', label: 'Private groups', Icon: Lock },
  { type: 'direct', label: 'Direct messages', Icon: User },
];

const iconOf = (type: ChatRoomType) => TYPES.find((entry) => entry.type === type)!.Icon;

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

// Its members, and what the knowledge base has of a room it reads
export const describeRoom = (room: ChatRoomChoice) => [
  room.members !== null && count(room.members, 'member'),
  room.stats && count(room.stats.messages, 'message'),
  room.stats?.threads && count(room.stats.threads, 'thread'),
  room.stats?.reacted && `${room.stats.reacted.toLocaleString()} with reactions`,
  room.stats?.images && `${count(room.stats.images, 'image')} (${room.stats.imagesRead.toLocaleString()} read)`,
  room.stats?.files && `${count(room.stats.files, 'file')} (${room.stats.filesRead.toLocaleString()} read)`,
  room.stats && (room.stats.checkedAt ? `synced ${formatWhen(room.stats.checkedAt)}` : 'not read yet'),
].filter(Boolean).join(' · ');

interface RoomSelectorProps {
  rooms: ChatRoomChoice[];
  selection: RoomSelection;
  onChange: (selection: RoomSelection) => void;
}

const RoomSelector = ({ rooms, selection, onChange }: RoomSelectorProps) => {
  const [query, setQuery] = useState('');
  // What the other mode had, so switching back keeps it
  const [chosen, setChosen] = useState<string[]>(selection.mode === 'chosen' ? selection.ids : []);
  const [types, setTypes] = useState<ChatRoomType[]>(selection.mode === 'all' ? selection.types : ['channel', 'group', 'direct']);
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);

    return rooms.filter((room) => words.every((word) => `${room.title} ${room.parent ?? ''}`.toLowerCase().includes(word)));
  }, [rooms, query]);

  const choose = (ids: string[]) => {
    setChosen(ids);
    onChange({ mode: 'chosen', ids });
  };

  const tick = (type: ChatRoomType, on: boolean) => {
    const next = on ? [...types, type] : types.filter((other) => other !== type);
    setTypes(next);
    onChange({ mode: 'all', types: next });
  };

  const count = (type: ChatRoomType) => rooms.filter((room) => room.type === type).length;
  const selected = new Set(chosen);

  return (
    <div className="space-y-3">
      <RadioGroup
        value={selection.mode}
        onValueChange={(mode) => onChange(mode === 'all' ? { mode: 'all', types } : { mode: 'chosen', ids: chosen })}
        className="flex gap-6"
      >
        <Label className="font-normal">
          <RadioGroupItem value="chosen" />
          Chosen rooms
        </Label>
        <Label className="font-normal">
          <RadioGroupItem value="all" />
          All my rooms
        </Label>
      </RadioGroup>
      {selection.mode === 'all' ? (
        <div className="space-y-2">
          {TYPES.map(({ type, label, Icon }) => (
            <Label key={type} className="font-normal">
              <Checkbox checked={types.includes(type)} onCheckedChange={(on) => tick(type, on === true)} />
              <Icon className="size-4 text-muted-foreground" />
              {label}
              <span className="text-muted-foreground">({count(type)})</span>
            </Label>
          ))}
          <p className="text-xs text-muted-foreground">Rooms you join later are read too. Livechat rooms never are.</p>
          {!types.length && <p className="text-xs text-destructive">Tick at least one kind of room.</p>}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Input placeholder="Find a room" value={query} onChange={(event) => setQuery(event.target.value)} />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => choose([...new Set([...chosen, ...shown.map((room) => room.id)])])}
              disabled={!shown.length}
            >
              Choose all shown
            </Button>
            <Button size="sm" variant="ghost" onClick={() => choose([])} disabled={!chosen.length}>Clear</Button>
          </div>
          <div className="max-h-64 overflow-y-auto rounded-md border">
            {shown.map((room) => {
              const Icon = iconOf(room.type);

              return (
                <Label key={room.id} className="flex cursor-pointer items-center gap-2 border-b px-3 py-2 font-normal last:border-b-0 hover:bg-accent">
                  <Checkbox
                    checked={selected.has(room.id)}
                    onCheckedChange={(on) => choose(on === true ? [...chosen, room.id] : chosen.filter((id) => id !== room.id))}
                  />
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 space-y-1">
                    <span className="block truncate" title={room.parent ? `${room.title} in ${room.parent}` : room.title}>
                      {room.title}
                      {room.parent && <span className="text-muted-foreground"> in {room.parent}</span>}
                    </span>
                    {describeRoom(room) && <span className="block truncate text-xs text-muted-foreground" title={describeRoom(room)}>{describeRoom(room)}</span>}
                  </span>
                  {room.lastMessageAt && <span className="shrink-0 text-xs text-muted-foreground">{formatDay(room.lastMessageAt)}</span>}
                </Label>
              );
            })}
            {!shown.length && <p className="p-3 text-sm text-muted-foreground">No room matches.</p>}
          </div>
          <p className="text-xs text-muted-foreground">
            {chosen.length} chosen. Rooms you join later can be added with &quot;Edit&quot;.
          </p>
        </div>
      )}
    </div>
  );
};

export const isSelectionEmpty = (selection: RoomSelection) => (selection.mode === 'chosen' ? !selection.ids.length : !selection.types.length);

export default RoomSelector;
