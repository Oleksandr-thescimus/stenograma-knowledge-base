import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from 'cn';

// A part shown on a click, such as a try of a model: made on the first open, then kept while closed, so a result
// isn't lost by closing it

const Expandable = ({ label, children }: { label: string, children: ReactNode }) => {
  const [open, setOpen] = useState(false);
  const [made, setMade] = useState(false);

  return (
    <div className="space-y-3 border-t pt-3">
      <button
        type="button"
        className="flex items-center gap-1 text-sm font-medium hover:underline"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          setMade(true);
        }}
      >
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        {label}
      </button>
      {made && <div className={cn(!open && 'hidden')}>{children}</div>}
    </div>
  );
};

export default Expandable;
