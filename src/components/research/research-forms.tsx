import { useHydrated } from "@tanstack/react-router";
import { Plus, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { RESEARCH_LIMITS, researchRequestSchema, type FieldSpecInput, type ResearchMode, type ResearchRequest } from "@/lib/crawl4ai/research-protocol";
import { cn } from "@/lib/utils";

type Props = { mode: ResearchMode; busy: boolean; cooldown: number; onSubmit: (req: ResearchRequest) => void; reuseSchema?: string | null };

const SCHEMA_STORE = "snapsolve.research.css-schemas";

function savedSchemaFor(url: string): string {
  try {
    const host = new URL(url).hostname;
    const map = JSON.parse(localStorage.getItem(SCHEMA_STORE) ?? "{}") as Record<string, string>;
    return map[host] ?? "";
  } catch {
    return "";
  }
}

export function rememberSchema(url: string, schema: string) {
  try {
    const host = new URL(url).hostname;
    const map = JSON.parse(localStorage.getItem(SCHEMA_STORE) ?? "{}") as Record<string, string>;
    map[host] = schema;
    const entries = Object.entries(map).slice(-30);
    localStorage.setItem(SCHEMA_STORE, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* storage full or blocked: the schema stays in the box */
  }
}

function AiBadge() {
  return <span className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-[10px] font-medium text-accent-foreground"><Sparkles className="size-3" />Lovable AI credits</span>;
}

function Field({ label, hint, children, htmlFor }: { label: ReactNode; hint?: ReactNode; children: ReactNode; htmlFor: string }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="text-sm">{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Toggle({ id, label, hint, checked, onChange, ai }: { id: string; label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; ai?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-xl border bg-background px-3 py-2.5">
      <label htmlFor={id} className="min-w-0 cursor-pointer">
        <span className="flex flex-wrap items-center gap-2 text-sm font-medium">{label}{ai && <AiBadge />}</span>
        {hint && <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>}
      </label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} className="mt-0.5 shrink-0" />
    </div>
  );
}

function Submit({ busy, cooldown, hydrated, label, ai }: { busy: boolean; cooldown: number; hydrated: boolean; label: string; ai: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-3 pt-1">
      <Button type="submit" disabled={!hydrated || busy || cooldown > 0} className="min-w-32">
        {cooldown > 0 ? `Wait ${cooldown}s` : busy ? "Working…" : label}
      </Button>
      <span className="text-xs text-muted-foreground">{ai ? "Uses Lovable AI credits." : "Free — no AI credits used."}</span>
    </div>
  );
}

const METHODS = [
  { id: "ai-fields", label: "AI: my fields", hint: "You name the fields, AI fills them for every item on the page.", ai: true },
  { id: "ai-blocks", label: "AI: smart blocks", hint: "AI splits the page into tagged blocks about your request.", ai: true },
  { id: "css-auto", label: "AI writes CSS schema", hint: "AI writes a reusable schema once; reuse it later for free.", ai: true },
  { id: "css-schema", label: "My CSS schema", hint: "Paste a Crawl4AI JsonCss schema. No AI.", ai: false },
  { id: "tables", label: "Tables only", hint: "Every data table on the page. No AI.", ai: false },
] as const;

const SCHEMA_EXAMPLE = `{
  "baseSelector": "li.question",
  "fields": [
    { "name": "title", "selector": "h3", "type": "text" },
    { "name": "link", "selector": "a", "type": "attribute", "attribute": "href" }
  ]
}`;

export function ResearchForm({ mode, busy, cooldown, onSubmit, reuseSchema }: Props) {
  const hydrated = useHydrated();
  const [error, setError] = useState("");
  // search
  const [query, setQuery] = useState("");
  const [site, setSite] = useState("");
  const [pages, setPages] = useState(4);
  const [answer, setAnswer] = useState(true);
  const [deepResearch, setDeepResearch] = useState(false);
  const [searchOcr, setSearchOcr] = useState(true);
  const [readOcr, setReadOcr] = useState(false);
  // read / deep / extract share the link
  const [url, setUrl] = useState("");
  const [focus, setFocus] = useState("");
  const [aiClean, setAiClean] = useState(false);
  const [question, setQuestion] = useState("");
  const [browserMode, setBrowserMode] = useState<"auto" | "always">("auto");
  const [screenshot, setScreenshot] = useState(false);
  const [strategy, setStrategy] = useState<"best-first" | "bfs" | "dfs">("best-first");
  const [sitemap, setSitemap] = useState(false);
  const [adaptive, setAdaptive] = useState(false);
  const [depth, setDepth] = useState(2);
  const [maxPages, setMaxPages] = useState(8);
  const [keywords, setKeywords] = useState("");
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [external, setExternal] = useState(false);
  const [summarize, setSummarize] = useState(false);
  const [method, setMethod] = useState<(typeof METHODS)[number]["id"]>("ai-fields");
  const [instruction, setInstruction] = useState("");
  const [fields, setFields] = useState<FieldSpecInput[]>([{ name: "title", type: "string" }, { name: "summary", type: "string", description: "one line" }]);
  const [schema, setSchema] = useState("");

  useEffect(() => {
    if (reuseSchema) {
      setMethod("css-schema");
      setSchema(reuseSchema);
    }
  }, [reuseSchema]);

  useEffect(() => setError(""), [mode]);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    let raw: unknown;
    if (mode === "search") raw = { mode, query, ...(site.trim() ? { site: site.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "") } : {}), pages, answer, deep: deepResearch, ocr: searchOcr };
    else if (mode === "read") raw = { mode, url, ...(focus.trim() ? { focus } : {}), aiClean, ...(question.trim() ? { question } : {}), browser: browserMode, screenshot, ocr: readOcr };
    else if (mode === "deep") raw = { mode, url, strategy, maxDepth: depth, maxPages, ...(keywords.trim() ? { keywords } : {}), ...(include.trim() ? { include } : {}), ...(exclude.trim() ? { exclude } : {}), includeExternal: external, sitemap, adaptive, summarize };
    else raw = { mode, url, method, ...(instruction.trim() ? { instruction } : {}), ...(method === "ai-fields" ? { fields: fields.filter((f) => f.name.trim()) } : {}), ...(method === "css-schema" ? { schema } : {}) };
    const parsed = researchRequestSchema.safeParse(raw);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Please check the form.");
      return;
    }
    if (parsed.data.mode === "extract" && parsed.data.method === "ai-fields" && !parsed.data.fields?.length) {
      setError("Add at least one field.");
      return;
    }
    if (parsed.data.mode === "extract" && parsed.data.method === "css-schema" && !parsed.data.schema?.trim()) {
      setError("Paste a CSS schema first.");
      return;
    }
    setError("");
    onSubmit(parsed.data);
  };

  const urlField = (
    <Field label="Web page link" htmlFor="research-url" hint={mode === "extract" ? undefined : "Web pages, PDFs and text files. JavaScript and bot-check pages are retried with a free browser reader. Pages that need a login cannot be read."}>
      <Input id="research-url" type="url" inputMode="url" required placeholder="https://…" value={url} onChange={(e) => {
        setUrl(e.target.value);
        if (mode === "extract" && method === "css-schema" && !schema) setSchema(savedSchemaFor(e.target.value));
      }} autoComplete="off" />
    </Field>
  );

  const ai =
    mode === "search" ||
    (mode === "read" && (aiClean || !!question.trim())) ||
    (mode === "deep" && summarize) ||
    (mode === "extract" && METHODS.find((m) => m.id === method)!.ai);

  return (
    <form onSubmit={submit} method="post" className="space-y-4 rounded-2xl border bg-card p-4 shadow-sm" noValidate>
      {mode === "search" && (
        <>
          <Field label="What do you want to find?" htmlFor="research-q">
            <Textarea id="research-q" required rows={2} maxLength={500} placeholder="e.g. NEET 2026 exam date and syllabus changes" value={query} onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Only this website (optional)" htmlFor="research-site" hint="e.g. ncert.nic.in or nta.ac.in">
              <Input id="research-site" placeholder="any website" value={site} onChange={(e) => setSite(e.target.value)} autoComplete="off" />
            </Field>
            <Field label={`Pages to read: ${pages}`} htmlFor="research-pages">
              <input id="research-pages" type="range" min={1} max={RESEARCH_LIMITS.searchPages} value={pages} onChange={(e) => setPages(Number(e.target.value))} className="w-full accent-primary" />
            </Field>
          </div>
          <Toggle id="research-answer" label="Write an answer with sources" hint="Uses only the pages that were actually read." checked={answer} onChange={setAnswer} ai />
          <Toggle id="research-deep" label="Deep research" hint="AI thinks harder, searches from more angles, reads longer parts of each page and compares sources. Slower and uses more credits." checked={deepResearch} onChange={setDeepResearch} ai />
          <Toggle id="research-ocr" label="Read scanned PDFs with AI" hint="Notices that are photos of paper (no text) are read by AI. Credits are used only when such a PDF is found." checked={searchOcr} onChange={setSearchOcr} ai />
        </>
      )}

      {mode === "read" && (
        <>
          {urlField}
          <Field label="Focus words (optional)" htmlFor="research-focus" hint="Keeps the parts of the page about these words (free, no AI).">
            <Input id="research-focus" placeholder="e.g. photosynthesis light reaction" value={focus} onChange={(e) => setFocus(e.target.value)} autoComplete="off" />
          </Field>
          <Toggle id="research-browser" label="Always open in a browser" hint="Reads the page as Chrome shows it, even when a direct read works. Slower." checked={browserMode === "always"} onChange={(v) => setBrowserMode(v ? "always" : "auto")} />
          <Toggle id="research-shot" label="Take a screenshot" hint="A picture of the page as it looks in a browser. Free." checked={screenshot} onChange={setScreenshot} />
          <Toggle id="research-read-ocr" label="Read scanned PDFs with AI" hint="If the link is a PDF of photographed pages, AI reads the text. Credits are used only for such PDFs." checked={readOcr} onChange={setReadOcr} ai />
          <Toggle id="research-clean" label="Clean up with AI" hint="AI removes menus and clutter and keeps the study content." checked={aiClean} onChange={setAiClean} ai />
          <Field label={<span className="flex items-center gap-2">Ask about this page (optional) <AiBadge /></span>} htmlFor="research-question">
            <Input id="research-question" placeholder="e.g. What are the key dates?" value={question} onChange={(e) => setQuestion(e.target.value)} autoComplete="off" />
          </Field>
        </>
      )}

      {mode === "deep" && (
        <>
          {urlField}
          <div role="radiogroup" aria-label="Crawl order" className="grid grid-cols-3 gap-1.5 rounded-xl bg-muted p-1">
            {([["best-first", "Best links first", "Follows links that match your words"], ["bfs", "Level by level", "Every link on each level"], ["dfs", "Deep first", "Follows one path to the end"]] as const).map(([id, label, hint]) => (
              <button key={id} type="button" role="radio" aria-checked={strategy === id} onClick={() => setStrategy(id)}
                className={cn("rounded-lg px-2 py-2 text-left transition-colors", strategy === id ? "bg-card shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                <span className="block text-sm font-medium">{label}</span>
                <span className="block text-[11px] leading-snug text-muted-foreground">{hint}</span>
              </button>
            ))}
          </div>
          <Field label="Keywords" htmlFor="research-kw" hint="Comma separated. Links and pages about these come first.">
            <Input id="research-kw" placeholder="e.g. biology, chapter, cell" value={keywords} onChange={(e) => setKeywords(e.target.value)} autoComplete="off" />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label={`Levels deep: ${depth}`} htmlFor="research-depth">
              <input id="research-depth" type="range" min={1} max={RESEARCH_LIMITS.deepDepth} value={depth} onChange={(e) => setDepth(Number(e.target.value))} className="w-full accent-primary" />
            </Field>
            <Field label={`Max pages: ${maxPages}`} htmlFor="research-max">
              <input id="research-max" type="range" min={1} max={RESEARCH_LIMITS.deepPages} value={maxPages} onChange={(e) => setMaxPages(Number(e.target.value))} className="w-full accent-primary" />
            </Field>
          </div>
          <Toggle id="research-sitemap" label="Find pages from the sitemap" hint="Reads the website's page list, so pages with no link from the start page are found too. Free." checked={sitemap} onChange={setSitemap} />
          <Toggle id="research-adaptive" label="Stop when enough is found" hint="Stops early once your keywords are well covered or new pages only repeat. Saves time." checked={adaptive} onChange={setAdaptive} />
          <details className="rounded-xl border bg-background px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">Link filters</summary>
            <div className="mt-3 space-y-3 pb-1">
              <Field label="Only links like" htmlFor="research-inc" hint="Use * as a wildcard, e.g. */textbook/*">
                <Input id="research-inc" value={include} onChange={(e) => setInclude(e.target.value)} autoComplete="off" />
              </Field>
              <Field label="Skip links like" htmlFor="research-exc" hint="e.g. *login*, *signup*">
                <Input id="research-exc" value={exclude} onChange={(e) => setExclude(e.target.value)} autoComplete="off" />
              </Field>
              <Toggle id="research-ext" label="Follow links to other websites" checked={external} onChange={setExternal} />
            </div>
          </details>
          <Toggle id="research-sum" label="Summarise what was found" hint="One cited summary of the crawled pages." checked={summarize} onChange={setSummarize} ai />
        </>
      )}

      {mode === "extract" && (
        <>
          {urlField}
          <fieldset className="space-y-1.5">
            <legend className="mb-1.5 text-sm font-medium">How to extract</legend>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {METHODS.map((m) => (
                <label key={m.id} className={cn("flex cursor-pointer gap-2 rounded-xl border px-3 py-2 transition-colors", method === m.id ? "border-primary bg-accent/50" : "bg-background hover:border-primary/40")}>
                  <input type="radio" name="research-method" value={m.id} checked={method === m.id} onChange={() => { setMethod(m.id); if (m.id === "css-schema" && !schema && url) setSchema(savedSchemaFor(url)); }} className="mt-1 accent-primary" />
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium">{m.label}{m.ai && <Sparkles className="size-3 text-primary" aria-label="uses AI credits" />}</span>
                    <span className="block text-[11px] leading-snug text-muted-foreground">{m.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          {(method === "ai-fields" || method === "ai-blocks" || method === "css-auto") && (
            <Field label="What should be extracted?" htmlFor="research-inst">
              <Textarea id="research-inst" rows={2} maxLength={600} placeholder="e.g. every college with its fees and cut-off" value={instruction} onChange={(e) => setInstruction(e.target.value)} />
            </Field>
          )}
          {method === "ai-fields" && (
            <div className="space-y-2">
              <p className="text-sm font-medium">Fields</p>
              {fields.map((f, i) => (
                <div key={i} className="grid grid-cols-[1fr_auto_auto] gap-1.5 sm:grid-cols-[1fr_7rem_1fr_auto]">
                  <Input aria-label={`Field ${i + 1} name`} placeholder="name" value={f.name} maxLength={40} onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                  <select aria-label={`Field ${i + 1} type`} value={f.type} onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, type: e.target.value as FieldSpecInput["type"] } : x)))}
                    className="h-9 rounded-md border bg-background px-2 text-sm">
                    <option value="string">text</option><option value="number">number</option><option value="boolean">yes/no</option><option value="list">list</option>
                  </select>
                  <Input aria-label={`Field ${i + 1} description`} placeholder="what it means (optional)" className="col-span-3 row-start-2 sm:col-span-1 sm:row-start-auto" value={f.description ?? ""} maxLength={200}
                    onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { name: x.name, type: x.type, ...(e.target.value ? { description: e.target.value } : {}) } : x)))} />
                  <Button type="button" variant="ghost" size="icon" className="size-9" aria-label={`Remove field ${i + 1}`} onClick={() => setFields((fs) => fs.filter((_, j) => j !== i))} disabled={fields.length <= 1}><Trash2 className="size-4" /></Button>
                </div>
              ))}
              {fields.length < RESEARCH_LIMITS.fields && (
                <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => setFields((fs) => [...fs, { name: "", type: "string" }])}><Plus className="size-4" />Add field</Button>
              )}
            </div>
          )}
          {method === "css-schema" && (
            <Field label="CSS schema (JSON)" htmlFor="research-schema" hint="Same format as Crawl4AI JsonCssExtractionStrategy. Schemas you reuse are remembered per website on this device.">
              <Textarea id="research-schema" rows={8} className="font-mono text-xs" placeholder={SCHEMA_EXAMPLE} value={schema} onChange={(e) => setSchema(e.target.value)} />
            </Field>
          )}
        </>
      )}

      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      <Submit busy={busy} cooldown={cooldown} hydrated={hydrated} ai={!!ai} label={mode === "search" ? "Search" : mode === "read" ? "Read page" : mode === "deep" ? "Start crawl" : "Extract"} />
    </form>
  );
}
