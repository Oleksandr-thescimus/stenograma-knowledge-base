import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// A browser's token, shown once, with how to paste it into the extension's popup

const TokenField = ({ label, token }: { label: string, token: string }) => {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(token);
    setCopied(true);
  };

  return (
    <div className="space-y-2">
      <Label>Token for {label}</Label>
      <div className="flex gap-2">
        <Input readOnly value={token} className="font-mono text-xs" onFocus={(event) => event.target.select()} />
        <Button variant="outline" size="icon" onClick={copy} aria-label="Copy the token">
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        In the extension&apos;s popup, open &quot;Local knowledge base&quot;, paste the token and turn it on. It&apos;s
        shown only now: the knowledge base keeps only its hash. If it&apos;s lost, &quot;New token&quot; in Sources makes
        another.
      </p>
    </div>
  );
};

export default TokenField;
