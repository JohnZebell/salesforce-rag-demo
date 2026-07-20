/**
 * Normalises whatever the n8n webhook hands back into { answer, sources }.
 *
 * The workflow returns `{ output: "<markdown>" }` with citations embedded in the
 * prose as bare parenthesised URLs, e.g. `(https://developer.salesforce.com/...)`.
 * There is no structured sources array, so we recover citations by scanning the
 * markdown, deduping by URL (the same doc is usually cited several times), and
 * rewriting each inline occurrence into a numbered marker that lines up with the
 * Sources block rendered beneath the answer.
 *
 * Ungrounded answers legitimately contain zero URLs — the agent says the docs
 * don't cover something rather than inventing a citation. That's a supported
 * state, not an error.
 */

export type Source = {
  n: number;
  url: string;
  title: string;
  host: string;
  path: string;
};

export type ParsedAnswer = {
  answer: string;
  sources: Source[];
};

/**
 * n8n webhook nodes return either a bare object or a single-element array
 * depending on how the "Respond to Webhook" node is configured, and the answer
 * itself has landed under a few different keys across workflow revisions. Try
 * the known shapes before giving up.
 */
export function extractOutput(body: unknown): string | null {
  let node: unknown = body;

  if (Array.isArray(node)) node = node[0];
  if (node && typeof node === "object" && "data" in node) {
    const inner = (node as Record<string, unknown>).data;
    if (inner && typeof inner === "object") node = inner;
  }

  if (typeof node === "string") return node.trim() ? node : null;
  if (!node || typeof node !== "object") return null;

  const rec = node as Record<string, unknown>;
  for (const key of ["output", "answer", "text", "response", "result", "message"]) {
    const value = rec[key];
    if (typeof value === "string" && value.trim()) return value;
  }

  return null;
}

// Trailing punctuation is almost always sentence punctuation or leftover markdown
// (a backtick from an inline code span, a closing quote), not part of the URL.
function tidyUrl(raw: string): string {
  return raw.replace(/[.,;:!?'"`*_)\]}]+$/, "");
}

/**
 * Derive a human-readable title from a docs URL, since the payload carries no
 * titles. `sforce_api_calls_convertlead.htm` -> "Sforce Api Calls Convertlead".
 */
function titleFromUrl(url: URL): string {
  const segments = url.pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? url.hostname;

  const cleaned = last
    .replace(/\.(htm|html|php|aspx)$/i, "")
    .replace(/[_-]+/g, " ")
    .trim();

  if (!cleaned) return url.hostname;

  return cleaned
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Hosts that serve actual documentation pages.
 *
 * Answers routinely contain URLs that are *not* citations — OAuth answers quote
 * endpoints like `https://login.salesforce.com/services/oauth2/token`, and some
 * include placeholder instance URLs such as `https://yourorg.my.salesforce.com`.
 * Treating those as sources produced a Sources block citing "Token", "Revoke",
 * and a placeholder domain, which is worse than showing nothing. Only URLs on a
 * docs host become citations; anything else is left in place as a plain link.
 */
const DOC_HOSTS = [
  "developer.salesforce.com",
  "help.salesforce.com",
  "trailhead.salesforce.com",
  "resources.docs.salesforce.com",
  "architect.salesforce.com",
  "admin.salesforce.com",
];

function isDocumentationUrl(url: URL): boolean {
  const host = url.hostname.replace(/^www\./, "");
  return DOC_HOSTS.includes(host);
}

/**
 * Matches a parenthesised URL or a bare URL. Markdown links (`[text](url)`) are
 * detected via the preceding `]` and left untouched so we don't mangle output
 * from any future workflow revision that emits proper links.
 */
const URL_PATTERN = /(\]\s*)?\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s)<>\]]+)/g;

export function parseAnswer(rawOutput: string): ParsedAnswer {
  const byUrl = new Map<string, Source>();

  const answer = rawOutput.replace(
    URL_PATTERN,
    (match, markdownLinkPrefix: string | undefined, parenUrl: string | undefined, bareUrl: string | undefined) => {
      // Already a well-formed markdown link — leave it alone.
      if (markdownLinkPrefix) return match;

      const url = tidyUrl(parenUrl ?? bareUrl ?? "");
      if (!url) return match;

      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return match; // Not a real URL; render as-is.
      }

      // Endpoints and placeholder hosts stay as plain text — remark-gfm still
      // autolinks them, they just don't pollute the Sources block.
      if (!isDocumentationUrl(parsed)) return match;

      let source = byUrl.get(url);
      if (!source) {
        source = {
          n: byUrl.size + 1,
          url,
          title: titleFromUrl(parsed),
          host: parsed.hostname.replace(/^www\./, ""),
          path: parsed.pathname,
        };
        byUrl.set(url, source);
      }

      // Renders as a link whose visible text is "[3]" — a compact citation
      // marker instead of a 100-character URL breaking up the prose.
      return ` [[${source.n}]](${url})`;
    },
  );

  return {
    answer: answer.replace(/[ \t]+\n/g, "\n").trim(),
    sources: [...byUrl.values()],
  };
}
