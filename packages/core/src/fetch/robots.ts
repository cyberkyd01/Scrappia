import robotsParserModule from 'robots-parser';
import { httpFetch } from './http.js';

interface Robots { isAllowed(url: string, ua?: string): boolean | undefined; getCrawlDelay(ua?: string): number | undefined }
const robotsParser = robotsParserModule as unknown as (url: string, txt: string) => Robots;

export class RobotsCache {
  private cache = new Map<string, Promise<Robots | null>>();
  constructor(private userAgent = 'Scrappia') {}

  private async load(origin: string): Promise<Robots | null> {
    try {
      const res = await httpFetch(`${origin}/robots.txt`, { timeoutMs: 10_000, userAgent: this.userAgent });
      if (res.status >= 400) return null;
      return robotsParser(`${origin}/robots.txt`, res.body);
    } catch { return null; }
  }

  async isAllowed(url: string): Promise<boolean> {
    let origin: string;
    try { origin = new URL(url).origin; } catch { return true; }
    let p = this.cache.get(origin);
    if (!p) { p = this.load(origin); this.cache.set(origin, p); }
    const robots = await p;
    if (!robots) return true;
    return robots.isAllowed(url, this.userAgent) !== false;
  }

  async crawlDelay(url: string): Promise<number | undefined> {
    let origin: string;
    try { origin = new URL(url).origin; } catch { return undefined; }
    const robots = await this.cache.get(origin);
    const d = robots?.getCrawlDelay(this.userAgent);
    return d ? d * 1000 : undefined;
  }
}
