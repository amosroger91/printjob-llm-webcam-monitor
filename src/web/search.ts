import type { WebSource } from "../types.js";

// Minimal DuckDuckGo HTML-endpoint search. No API key, no tracking cookies. We send
// ONLY a short text query (e.g. branding read off the machine) — never the webcam
// image. The HTML endpoint returns server-rendered results we parse with a couple of
// narrow regexes; if its markup ever changes this fails soft (returns []), and the
// caller falls back to the vision-only guess.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) print-watch/0.1";

export async function ddgSearch(
  query: string,
  opts: { endpoint?: string; limit?: number; timeoutMs?: number } = {},
): Promise<WebSource[]> {
  const endpoint = opts.endpoint || "https://html.duckduckgo.com/html/";
  const limit = opts.limit ?? 5;
  const url = `${endpoint}?q=${encodeURIComponent(query)}`;

  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 12_000),
  });
  if (!res.ok) throw new Error(`duckduckgo returned ${res.status}`);
  const html = await res.text();
  return parseResults(html, limit);
}

// Titles and snippets each render as an <a class="result__a|result__snippet" ...>…</a>,
// emitted in matching order. We extract both streams and zip them by index.
function parseResults(html: string, limit: number): WebSource[] {
  const titles = [...html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map((m) =>
    cleanText(m[1]),
  );

  const out: WebSource[] = [];
  for (let i = 0; i < titles.length && out.length < limit; i++) {
    const url = resolveUrl(titles[i][1]);
    const title = cleanText(titles[i][2]);
    if (!title) continue;
    out.push({ title, url, snippet: snippets[i] ?? "" });
  }
  return out;
}

// DDG wraps result links as /l/?uddg=<encoded-real-url>. Unwrap to the real target.
function resolveUrl(href: string): string {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      /* fall through */
    }
  }
  return href.startsWith("//") ? `https:${href}` : href;
}

function cleanText(s: string): string {
  return s
    .replace(/<[^>]+>/g, "") // drop <b> highlight tags etc.
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
