// An answer's [n] citations (F6), as parts to render: text, or a citation to link to its source

export type AnswerPart = { kind: 'text', text: string } | { kind: 'citation', n: number };

export const splitCitations = (text: string): AnswerPart[] => {
  const parts: AnswerPart[] = [];
  let last = 0;

  for (const match of text.matchAll(/\[(\d{1,3})\]/g)) {
    if (match.index > last) {
      parts.push({ kind: 'text', text: text.slice(last, match.index) });
    }

    parts.push({ kind: 'citation', n: Number(match[1]) });
    last = match.index + match[0].length;
  }

  if (last < text.length) {
    parts.push({ kind: 'text', text: text.slice(last) });
  }

  return parts;
};

// Markdown with each citation of a known source as a link the renderer turns into a button: `[1]` would otherwise be
// read as a reference link, and `[1][2]` as one with the label 2
export const linkCitations = (text: string, known: Set<number>) => splitCitations(text)
  .map((part) => {
    if (part.kind === 'text') {
      return part.text;
    }

    return known.has(part.n) ? `[${part.n}](#cite-${part.n})` : `\\[${part.n}\\]`;
  })
  .join('');

export const citationOf = (href: string | undefined) => {
  const match = /^#cite-(\d+)$/.exec(href ?? '');

  return match ? Number(match[1]) : null;
};

export const citedNumbers = (text: string) => new Set(splitCitations(text).flatMap((part) => (part.kind === 'citation' ? [part.n] : [])));
