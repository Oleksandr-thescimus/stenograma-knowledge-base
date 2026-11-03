import type { ReactNode } from 'react';
import Markdown, { type MarkdownToJSX } from 'markdown-to-jsx';
import { citationOf, linkCitations } from '@/lib/citations';

// The extension's components/MarkdownText.tsx, with Tailwind's typography plugin instead of MUI's sx, and [n]
// citations as buttons. Raw HTML in the text is shown as text, so an AI answer can't inject markup into the page

interface MarkdownTextProps {
  text: string;
  // The numbers that have a source; others stay text
  citations?: Set<number>;
  onCitation?: (n: number) => void;
}

const MarkdownText = ({ text, citations = new Set(), onCitation }: MarkdownTextProps) => {
  // Links of the answer open in the browser (the main process's window open handler); citations open their source
  const Link = ({ href, children }: { href?: string, children?: ReactNode }) => {
    const n = citationOf(href);

    if (n !== null) {
      return (
        <button
          type="button"
          onClick={() => onCitation?.(n)}
          className="mx-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded bg-primary/15 px-1 align-text-top text-xs font-medium text-primary no-underline hover:bg-primary/30"
        >
          {n}
        </button>
      );
    }

    return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
  };

  const options: MarkdownToJSX.Options = { disableParsingRawHTML: true, forceBlock: true, overrides: { a: { component: Link } } };

  return (
    // Models often end lines with a single newline, which Markdown would otherwise join into one line
    <div className="prose prose-sm max-w-none text-foreground dark:prose-invert prose-p:my-1.5 prose-p:whitespace-pre-line prose-li:my-0.5 prose-li:whitespace-pre-line prose-pre:bg-code prose-code:before:content-none prose-code:after:content-none [&>:first-child]:mt-0 [&>:last-child]:mb-0">
      <Markdown options={options}>
        {linkCitations(text, citations)}
      </Markdown>
    </div>
  );
};

export default MarkdownText;
