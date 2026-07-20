"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Source } from "@/lib/parse";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  /** Total URLs in the answer, including non-documentation ones. See ParsedAnswer. */
  urlsFound?: number;
  isError?: boolean;
};

function SourceList({ sources }: { sources: Source[] }) {
  return (
    <div className="mt-5 border-t border-[rgba(87,163,253,0.14)] pt-4">
      <h3 className="mb-3 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-[#7e90b0]">
        Sources · {sources.length}
      </h3>
      <ol className="space-y-1.5">
        {sources.map((source) => (
          <li key={source.url}>
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-start gap-3 rounded-lg px-2.5 py-2 -mx-2.5 transition-colors hover:bg-[rgba(87,163,253,0.08)]"
            >
              <span className="mt-0.5 flex h-5 min-w-5 items-center justify-center rounded-md border border-[rgba(87,163,253,0.3)] bg-[rgba(87,163,253,0.12)] px-1 text-[0.68rem] font-semibold text-[#8dc2ff]">
                {source.n}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-[#cfdcf2] group-hover:text-white">
                  {source.title}
                </span>
                <span className="block truncate text-xs text-[#6c7d9c]">
                  {source.host}
                  {source.path}
                </span>
              </span>
              <svg
                aria-hidden
                viewBox="0 0 16 16"
                className="mt-1 h-3.5 w-3.5 shrink-0 text-[#4c5f85] transition-colors group-hover:text-[#8dc2ff]"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M6 3h7v7M13 3 4 12" />
              </svg>
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}

function NoSourcesNote() {
  return (
    <div className="mt-5 flex items-start gap-2.5 rounded-xl border border-[rgba(255,255,255,0.07)] bg-[rgba(255,255,255,0.025)] px-3.5 py-3">
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#7e90b0]"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      >
        <circle cx="8" cy="8" r="6.5" />
        <path d="M8 7.5v4M8 4.75v.5" />
      </svg>
      <p className="text-xs leading-relaxed text-[#8b9bb8]">
        No sources cited — this answer wasn&apos;t grounded in the indexed documentation.
        Treat it as general knowledge and verify before relying on it.
      </p>
    </div>
  );
}

export default function Message({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <div className="rise-in flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md border border-[rgba(87,163,253,0.3)] bg-[rgba(1,118,211,0.22)] px-4 py-3 text-[0.9375rem] leading-relaxed text-[#eaf2ff]">
          {message.content}
        </div>
      </div>
    );
  }

  if (message.isError) {
    return (
      <div className="rise-in rounded-2xl rounded-bl-md border border-[rgba(255,138,138,0.28)] bg-[rgba(255,90,90,0.09)] px-4 py-3 text-sm text-[#ffc9c9]">
        {message.content}
      </div>
    );
  }

  const sources = message.sources ?? [];
  // Only claim the answer is ungrounded when it cites nothing whatsoever. An
  // answer that links, say, an OAuth endpoint has URLs but no documentation
  // sources — those links stay inline and we simply show no Sources block,
  // rather than asserting it wasn't grounded.
  const citesNothing = sources.length === 0 && (message.urlsFound ?? 0) === 0;

  return (
    <div className="rise-in card-glow rounded-2xl rounded-bl-md border-l-2 border-l-sf-blue-bright px-5 py-4">
      <div className="answer-prose">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a({ href, children, ...props }) {
              // The parser rewrites inline citations to `[[3]](url)`, which
              // arrives here as the literal text "[3]".
              const label = String(children);
              const isMarker = /^\[\d+\]$/.test(label);
              return (
                <a
                  {...props}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={isMarker ? "citation-marker" : undefined}
                  title={isMarker ? href : undefined}
                >
                  {isMarker ? label.slice(1, -1) : children}
                </a>
              );
            },
          }}
        >
          {message.content}
        </ReactMarkdown>
      </div>

      {sources.length > 0 ? <SourceList sources={sources} /> : null}
      {citesNothing ? <NoSourcesNote /> : null}
    </div>
  );
}
