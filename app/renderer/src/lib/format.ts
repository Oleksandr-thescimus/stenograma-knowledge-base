// Dates and moments as people read them, in local time
export { formatDay, formatMoment } from '../../../../core/format';

// 12:34 into a meeting
export const formatOffset = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, '0');

  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
};

export const formatTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// "11:33" today, else the day and the time
export const formatWhen = (ms: number) => {
  const date = new Date(ms);
  const today = new Date();

  return date.toDateString() === today.toDateString()
    ? formatTime(ms)
    : `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${formatTime(ms)}`;
};

// A browser's label, or what an imported backup or a later source is
export const sourceName = (source: { kind: string, account: string | null }) => {
  if (source.kind === 'stenograma-browser') {
    return source.account || 'Browser';
  }

  if (source.kind === 'stenograma-backup') {
    return 'Imported backup';
  }

  return source.account || source.kind;
};
