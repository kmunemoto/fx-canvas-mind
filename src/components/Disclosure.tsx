import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useT } from "@/lib/i18n";

interface Props {
  icon?: ReactNode;
  title: string;
  // Rendered in the header whether open or closed, so a count or a verdict
  // the reader needs is never behind the fold
  summary?: ReactNode;
  testId?: string;
  children: ReactNode;
}

// A closed-by-default section for the evidence that backs a result without
// being the result. The result screen used to be eight glass cards of equal
// weight in one column, so on a phone the numbers a reader checks once sat at
// the same weight as the call they read every time. This is deliberately
// lighter than a card: a thin border, no glow, one row until it is opened.
const Disclosure = ({ icon, title, summary, testId, children }: Props) => {
  const t = useT();
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-xl border border-border/60" data-testid={testId}>
      <CollapsibleTrigger asChild>
        <button type="button" className="w-full flex items-center gap-2 px-3 py-2.5 text-left">
          {icon && <span className="text-primary shrink-0" aria-hidden="true">{icon}</span>}
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-foreground">{title}</span>
            {summary && <span className="block text-[11px] text-muted-foreground">{summary}</span>}
          </span>
          <span className="shrink-0 flex items-center gap-1 text-[10px] text-muted-foreground">
            {open ? t.disclosure.close : t.disclosure.open}
            {open
              ? <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
              : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-3 pb-3">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
};

export default Disclosure;
