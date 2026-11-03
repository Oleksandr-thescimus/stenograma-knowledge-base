// Dates and moments as people read them: local time

export const formatDay = (ms: number) => {
  if (!ms) {
    return 'unknown date';
  }

  const date = new Date(ms);

  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

// " at 12:34" into a meeting, or nothing when the chunk has no start
export const formatMoment = (ms: number | null | undefined) => {
  if (ms === null || ms === undefined) {
    return '';
  }

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);

  return ` at ${minutes}:${String(seconds % 60).padStart(2, '0')}`;
};
