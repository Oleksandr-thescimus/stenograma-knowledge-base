import { cn } from 'cn';
import type { CitedSource } from '../../../../core/protocol';
import { Badge } from '@/components/ui/badge';
import { formatChunkStart, formatDay } from '@/lib/format';

// A cited source under an answer or a reply draft. A removed source is still listed, as its text cites it, but no longer
// opens
const SourceRow = ({ source, onOpen, dimmed }: { source: CitedSource, onOpen: (source: CitedSource) => void, dimmed?: boolean }) => (
  <button
    type="button"
    onClick={() => onOpen(source)}
    disabled={source.removed}
    className={cn(
      'flex w-full items-baseline gap-2 rounded px-2 py-1 text-left text-sm enabled:hover:bg-accent',
      (dimmed || source.removed) && 'text-muted-foreground',
    )}
  >
    <span className="w-6 shrink-0 text-xs font-medium text-primary">[{source.n}]</span>
    <span className="min-w-0 truncate">{source.title}</span>
    <span className="shrink-0 text-xs text-muted-foreground">
      {formatDay(source.createdAt)}
      {formatChunkStart(source)}
    </span>
    {source.madeByAi && <Badge variant="outline" className="shrink-0">made by AI</Badge>}
    {source.removed && <Badge variant="outline" className="shrink-0">removed</Badge>}
  </button>
);

export default SourceRow;
