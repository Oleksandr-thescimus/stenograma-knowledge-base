import { describe, expect, it } from 'vitest';
import { nameMatches, nameSkeleton, normalizeForSearch, stemWord, toFtsQuery } from '../../core/text/normalize.ts';

describe('search text', () => {
  it('turns every apostrophe into ʼ, which FTS5 keeps inside a word', () => {
    expect(['п\'ять', 'п’ять', 'пʼять'].map(normalizeForSearch)).toEqual(['пʼять', 'пʼять', 'пʼять']);
  });

  it('drops one ending from a 5+ letter word, leaving at least 4 letters', () => {
    expect(stemWord('бюджету')).toBe('бюджет');
    expect(stemWord('зустрічами')).toBe('зустріч');
    expect(stemWord('реліз')).toBe('реліз');
    expect(stemWord('план')).toBe('план');
  });

  it('makes an ORed FTS5 query of the words that matter', () => {
    expect(toFtsQuery('Що казала Олена про бюджету?')).toBe('"каза"* OR "олен"* OR "бюджет"*');
    expect(toFtsQuery('що і як')).toBeNull();
  });
});

describe('names (F5)', () => {
  it('matches one person written in Cyrillic and Latin, with the usual spellings', () => {
    expect(nameMatches('Yulija Hiryak', 'Юлія')).toBe(true);
    expect(nameMatches('Oleg PM', 'Олег')).toBe(true);
    expect(nameMatches('Oleh M', 'Олег')).toBe(true);
    expect(nameMatches('Mykhailo K', 'Михайло')).toBe(true);
    expect(nameMatches('Михайло Кутинський', 'Mykhailo')).toBe(true);
  });

  it('doesn\'t match other people or too short names', () => {
    expect(nameMatches('Andrii Tretiak', 'Олег')).toBe(false);
    expect(nameMatches('Olena', 'Ol')).toBe(false);
    expect(nameSkeleton('Сергій')).toBe(nameSkeleton('serhii'));
  });
});
