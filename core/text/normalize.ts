// Text and queries for FTS5 with unicode61, which splits words on ' and ’ ("п'ять" into "п" and "ять") but takes ʼ
// (U+02BC) as a letter. Its remove_diacritics touches Latin letters only, which Ukrainian doesn't need
export const normalizeForSearch = (text: string) => text.replace(/['’‘`]/g, 'ʼ');

// Endings dropped from a query word of 5+ letters, the longest that leaves at least 4 letters ("бюджету" → бюджет*)
const ENDINGS = [
  'ування', 'ються', 'ується', 'ання', 'ення', 'іння', 'ість', 'ості', 'ував', 'ують', 'ами', 'ями', 'ові', 'еві', 'ого',
  'ому', 'ими', 'іми', 'ати', 'ити', 'или', 'ала', 'ять', 'ють', 'ться', 'ся', 'ий', 'ій', 'ої', 'ою', 'ею', 'ам', 'ям',
  'ах', 'ях', 'ів', 'ом', 'ем', 'ла', 'ло', 'ли', 'ти', 'ть', 'ив', 'ує', 'ає', 'а', 'я', 'о', 'е', 'і', 'и', 'ї', 'у',
  'ю', 's',
].sort((a, b) => b.length - a.length);

const STOP_WORDS = new Set([
  'що', 'як', 'який', 'яка', 'які', 'яке', 'про', 'для', 'чи', 'та', 'на', 'це', 'ми', 'ви', 'він', 'вона', 'вони', 'його',
  'її', 'їх', 'був', 'була', 'було', 'були', 'коли', 'хто', 'чому', 'де', 'якщо', 'але', 'не', 'так', 'той', 'ця', 'цей',
  'ці', 'там', 'вже', 'ще', 'щоб', 'після', 'перед', 'між', 'мені', 'нам', 'вам', 'або', 'теж', 'також', 'the', 'and',
  'are', 'was', 'were', 'did', 'does', 'what', 'which', 'who', 'for', 'any', 'anyone', 'our', 'its', 'how', 'there',
  'has', 'have', 'from', 'with', 'that', 'this',
]);

export const stemWord = (word: string) => {
  if (word.length < 5) {
    return word;
  }

  const ending = ENDINGS.find((candidate) => word.endsWith(candidate) && word.length - candidate.length >= 4);

  return ending ? word.slice(0, -ending.length) : word;
};

// The words of a query as an FTS5 expression: ORed, a 5+ letter word as a prefix of its stem. Null when nothing is left
export const toFtsQuery = (query: string) => {
  const words = [...new Set(normalizeForSearch(query.toLowerCase()).match(/[\p{L}\p{N}ʼ]+/gu) ?? [])]
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));

  return words.length ? words.map((word) => (word.length >= 5 ? `"${stemWord(word)}"*` : `"${word}"`)).join(' OR ') : null;
};

const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch',
  ш: 'sh', щ: 'shch', ь: '', ю: 'iu', я: 'ia', ы: 'y', э: 'e', ъ: '', ё: 'e', ʼ: '',
};

// One person is written differently in Meet, email and Telegram ("Олег", "Oleg", "Oleh"; "Юлія", "Yulija"), so names
// are compared as a rough Latin skeleton: transliterated, with g/h, kh/h and y/j/i merged and doubled letters collapsed
export const nameSkeleton = (name: string) => [...normalizeForSearch(name.toLowerCase())]
  .map((char) => CYRILLIC_TO_LATIN[char] ?? char).join('')
  .replace(/kh/g, 'h').replace(/g/g, 'h').replace(/[yj]/g, 'i').replace(/(.)\1+/g, '$1')
  .replace(/[^a-z0-9]+/g, ' ').trim();

// Whether a name (as written somewhere) matches the person asked about: each word of the person's name starts a word
// of the name, words of 3+ letters only
export const nameMatches = (name: string, person: string) => {
  const nameWords = nameSkeleton(name).split(' ');
  const personWords = nameSkeleton(person).split(' ').filter((word) => word.length >= 3);

  return personWords.length > 0 && personWords.every((word) => nameWords.some((candidate) => candidate.startsWith(word)));
};
