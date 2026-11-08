import { Link } from "@tanstack/react-router";
import { ArrowRight, Globe } from "lucide-react";

/** Home card for Web Research (Crawl4AI engine + Lovable AI). */
export function ResearchEntryCard() {
  return (
    <Link to="/research" className="touch-btn group mt-2 flex items-center gap-3 rounded-xl border bg-card p-3 shadow-sm transition-colors hover:border-primary/40 md:mt-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground"><Globe className="size-4" /></span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">Web Research</span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">Search · Read page · Deep crawl · Extract</span>
      </span>
      <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
    </Link>
  );
}
