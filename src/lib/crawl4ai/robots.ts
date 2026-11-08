/**
 * robots.txt support (Crawl4AI check_robots_txt): groups per user-agent, Allow/Disallow with `*` and
 * `$`, longest match wins, Allow wins ties. Used by deep crawls; single user-requested reads skip it.
 */

export type RobotsRules = { allow: string[]; disallow: string[]; crawlDelay?: number };

export const CRAWLER_AGENT = "snapsolvebot";

export function parseRobots(body: string, agent = CRAWLER_AGENT): RobotsRules {
  type Group = { agents: string[]; allow: string[]; disallow: string[]; delay?: number };
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) { current = { agents: [], allow: [], disallow: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" && value) current.allow.push(value);
    else if (key === "disallow" && value) current.disallow.push(value);
    else if (key === "crawl-delay") {
      const d = Number(value);
      if (Number.isFinite(d)) current.delay = d;
    }
  }
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && agent.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  const rules: RobotsRules = { allow: chosen.flatMap((g) => g.allow), disallow: chosen.flatMap((g) => g.disallow) };
  const delay = chosen.find((g) => g.delay !== undefined)?.delay;
  if (delay !== undefined) rules.crawlDelay = delay;
  return rules;
}

function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern).split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

export function isAllowed(rules: RobotsRules, pathAndQuery: string): boolean {
  let best: { len: number; allow: boolean } | null = null;
  const consider = (list: string[], allow: boolean) => {
    for (const p of list) {
      if (!patternToRegex(p).test(pathAndQuery)) continue;
      const len = p.length;
      if (!best || len > best.len || (len === best.len && allow)) best = { len, allow };
    }
  };
  consider(rules.disallow, false);
  consider(rules.allow, true);
  return best ? (best as { allow: boolean }).allow : true;
}

const cache = new Map<string, { at: number; rules: RobotsRules }>();
const TTL_MS = 60 * 60 * 1000;

/** Loads (and caches for an hour) the rules for a URL's origin; unreachable robots.txt means allowed. */
export async function robotsFor(url: string, load: (robotsUrl: string) => Promise<string | null>): Promise<RobotsRules> {
  const origin = new URL(url).origin;
  const hit = cache.get(origin);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rules;
  let rules: RobotsRules = { allow: [], disallow: [] };
  try {
    const body = await load(`${origin}/robots.txt`);
    if (body) rules = parseRobots(body);
  } catch {
    /* unreachable robots.txt → allow */
  }
  if (cache.size > 500) cache.clear();
  cache.set(origin, { at: Date.now(), rules });
  return rules;
}
