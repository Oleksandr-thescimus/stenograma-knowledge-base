import { cn } from 'cn';
import type { AppStatus } from '../../../../core/protocol';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { describeStatus, type StatusPage, type Tone } from '@/lib/status';

// The sidebar's status line (lib/status.ts): a click opens the page where it's seen and fixed

const DOTS: Record<Tone, string> = {
  ok: 'bg-success',
  busy: 'bg-warning',
  idle: 'bg-muted-foreground/50',
  error: 'bg-destructive',
};

interface StatusLineProps {
  status: AppStatus | null;
  onOpen: (page: StatusPage) => void;
}

const StatusLine = ({ status, onOpen }: StatusLineProps) => {
  const summary = describeStatus(status);

  const line = (
    <button
      type="button"
      disabled={!summary.page}
      onClick={() => summary.page && onOpen(summary.page)}
      className="mt-2 flex w-full items-start gap-2 rounded-md px-2 py-1 text-left text-xs text-muted-foreground enabled:hover:bg-accent enabled:hover:text-foreground"
    >
      <span className={cn('mt-1 size-2 shrink-0 rounded-full', DOTS[summary.tone])} aria-hidden />
      <span className="line-clamp-2">{summary.text}</span>
    </button>
  );

  if (!summary.details.length) {
    return line;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{line}</TooltipTrigger>
      <TooltipContent side="right" align="end" className="space-y-0.5">
        {summary.details.map((detail) => <p key={detail}>{detail}</p>)}
      </TooltipContent>
    </Tooltip>
  );
};

export default StatusLine;
