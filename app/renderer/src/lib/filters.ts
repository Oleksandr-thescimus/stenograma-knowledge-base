import type { AskPart, SearchFilters } from '../../../../core/protocol';
import { formatDay } from '@/lib/format';

// The chat's filters: set by hand in the composer, and taken from the question by the rewrite (shown under "Searched
// for"). Each is a chip with ✕

export interface FilterFields {
  from: string;
  to: string;
  person: string;
  room: string;
  // A meeting series's name; '' for none
  series: string;
  sourceKind: string;
}

export const NO_FILTERS: FilterFields = { from: '', to: '', person: '', room: '', series: '', sourceKind: 'all' };

export const SOURCE_KINDS = [
  { value: 'all', label: 'All sources' },
  { value: 'stenograma', label: 'Meetings' },
  { value: 'rocketchat', label: 'Rocket.Chat' },
];

const dayStart = (day: string) => new Date(`${day}T00:00:00`).getTime();

// Days from the date fields: from the start of `from` to the end of `to`
export const toFilters = (fields: FilterFields): SearchFilters => {
  const next = fields.to ? new Date(`${fields.to}T00:00:00`) : null;
  next?.setDate(next.getDate() + 1);

  return {
    ...(fields.from && { from: dayStart(fields.from) }),
    ...(next && { to: next.getTime() }),
    ...(fields.person.trim() && { person: fields.person.trim() }),
    ...(fields.room.trim() && { room: fields.room.trim().replace(/^#/, '') }),
    ...(fields.series && { series: fields.series }),
    ...(fields.sourceKind !== 'all' && { sourceKind: fields.sourceKind }),
  };
};

const shortDay = (ms: number) => new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' });

export const describeDays = (from: number | undefined, to: number | undefined) => {
  if (from !== undefined && to !== undefined) {
    return formatDay(from) === formatDay(to - 1) ? shortDay(from) : `${shortDay(from)} – ${shortDay(to - 1)}`;
  }

  return from !== undefined ? `from ${shortDay(from)}` : `to ${shortDay(to! - 1)}`;
};

export interface Chip {
  key: string;
  label: string;
}

// The composer's filters set by hand, as chips; ✕ empties their fields
export const fieldChips = (fields: FilterFields) => {
  const filters = toFilters(fields);
  const chips: (Chip & { clear: Partial<FilterFields> })[] = [];

  if (filters.from !== undefined || filters.to !== undefined) {
    chips.push({ key: 'dates', label: describeDays(filters.from, filters.to), clear: { from: '', to: '' } });
  }

  if (filters.person) {
    chips.push({ key: 'person', label: `person: ${filters.person}`, clear: { person: '' } });
  }

  if (filters.room) {
    chips.push({ key: 'room', label: `room: ${filters.room}`, clear: { room: '' } });
  }

  if (filters.series) {
    chips.push({ key: 'series', label: `series: ${filters.series}`, clear: { series: '' } });
  }

  if (filters.sourceKind) {
    chips.push({ key: 'source', label: SOURCE_KINDS.find((kind) => kind.value === filters.sourceKind)?.label ?? filters.sourceKind, clear: { sourceKind: 'all' } });
  }

  return chips;
};

export type Without = 'dates' | 'person' | 'room' | 'rank' | 'series';

// What the rewrite took from the question, as chips; ✕ asks again without it
export const requestChips = (request: Extract<AskPart, { kind: 'request' }>) => {
  const chips: (Chip & { key: Without })[] = [];

  if (request.from !== undefined || request.to !== undefined) {
    chips.push({ key: 'dates', label: describeDays(request.from, request.to) });
  }

  if (request.person) {
    chips.push({ key: 'person', label: `person: ${request.person}` });
  }

  if (request.room) {
    chips.push({ key: 'room', label: `room: ${request.room}` });
  }

  if (request.rank === 'reactions') {
    chips.push({ key: 'rank', label: 'by the most reactions' });
  }

  if (request.series) {
    chips.push({ key: 'series', label: `series: ${request.series}` });
  }

  return chips;
};
