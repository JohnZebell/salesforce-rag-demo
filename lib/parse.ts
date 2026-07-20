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
  /**
   * Every http(s) URL in the raw output, including ones filtered out of
   * `sources` for being on a non-docs host. The UI needs this to tell
   * "ungrounded answer, no citations at all" apart from "cited something we
   * don't treat as a documentation source" — showing the same "No sources
   * cited" disclaimer for both is wrong, and was.
   */
  urlsFound: number;
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
 * The three shapes a citation arrives in, tried in this order:
 *
 *   1. Markdown link — `[label](url)`. Kept exactly as written so we don't
 *      mangle a workflow revision that emits proper links, but the URL is still
 *      registered as a source. Previously these were skipped entirely, which
 *      meant an answer whose citations were all markdown links reported zero
 *      sources and got the "not grounded" disclaimer.
 *   2. Parenthesised citation — `(https://…)` and the prefixed form the agent
 *      actually emits, `(Source: https://…)`. The prefix and the parens are
 *      consumed along with the URL; leaving them behind produced the literal
 *      text `(Source:  [[1]](url))` in the rendered answer. Several URLs may
 *      share one parenthesis, comma- or semicolon-separated.
 *   3. Bare URL sitting in the prose.
 */
const CITATION_PATTERN = new RegExp(
  [
    String.raw`\[[^\]]*\]\((https?:\/\/[^\s)]+)\)`,
    String.raw`\(\s*(?:sources?|see|ref(?:erence)?|from)\s*:\s*((?:https?:\/\/[^\s,;)]+)(?:\s*[,;]\s*https?:\/\/[^\s,;)]+)*)\s*\)`,
    String.raw`\(\s*((?:https?:\/\/[^\s,;)]+)(?:\s*[,;]\s*https?:\/\/[^\s,;)]+)*)\s*\)`,
    String.raw`(https?:\/\/[^\s)<>\]]+)`,
  ].join("|"),
  "gi",
);

const ANY_URL = /https?:\/\//g;

export function parseAnswer(rawOutput: string): ParsedAnswer {
  const byUrl = new Map<string, Source>();

  /** Register a URL as a citation. Returns its marker, or null if it isn't a
   *  documentation URL and should be left in the prose untouched. */
  function register(rawUrl: string): string | null {
    const url = tidyUrl(rawUrl);
    if (!url) return null;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null; // Not a real URL; render as-is.
    }

    // Endpoints and placeholder hosts stay as plain text — remark-gfm still
    // autolinks them, they just don't pollute the Sources block.
    if (!isDocumentationUrl(parsed)) return null;

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
    return `[[${source.n}]](${url})`;
  }

  const answer = rawOutput.replace(
    CITATION_PATTERN,
    (
      match,
      markdownUrl: string | undefined,
      prefixedUrls: string | undefined,
      parenUrls: string | undefined,
      bareUrl: string | undefined,
    ) => {
      // Already a well-formed markdown link: collect the citation, keep the link.
      if (markdownUrl) {
        register(markdownUrl);
        return match;
      }

      const group = prefixedUrls ?? parenUrls;
      if (group) {
        const markers = group
          .split(/\s*[,;]\s*/)
          .map((u) => register(u))
          .filter((m): m is string => m !== null);
        // None of them were documentation URLs — leave the original text alone
        // rather than stripping a "(Source: …)" the reader still wants to see.
        return markers.length ? markers.join(" ") : match;
      }

      if (bareUrl) return register(bareUrl) ?? match;
      return match;
    },
  );

  return {
    answer: answer
      .replace(/[ \t]{2,}/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .trim(),
    sources: [...byUrl.values()],
    urlsFound: (rawOutput.match(ANY_URL) ?? []).length,
  };
}
