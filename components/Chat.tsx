"use client";

import { useEffect, useRef, useState } from "react";
import Message, { type ChatMessage } from "./Message";
import type { Source } from "@/lib/parse";

// Chosen because they land in well-indexed parts of the corpus and come back
// grounded. Avoid Apex-specific questions here — those docs are filtered out of
// the index, so they answer with no citations, which undersells the demo on the
// very first click.
// Every entry here is verified against the live webhook to return cited sources —
// see README. Two constraints shaped the list: Apex docs are filtered out of the
// corpus (those answer uncited), and retrieval currently only has real depth on
// lead conversion. Re-verify before changing any of these.
const SAMPLE_QUESTIONS = [
  "How do I convert a lead using the API?",
  "What does the convertLead API return?",
  "What are the required permissions to convert a lead?",
  "What is the LeadConvert object?",
];

let messageCounter = 0;
const nextId = () => `m${++messageCounter}`;

/**
 * Per-tab identifier forwarded to n8n so the workflow can scope its conversation
 * memory to one visitor. Lives in sessionStorage, so it dies with the tab — no
 * cross-session tracking, consistent with the no-persistence promise.
 */
function getSessionId(): string {
  const KEY = "sfdocs-session-id";
  try {
    const existing = sessionStorage.getItem(KEY);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    sessionStorage.setItem(KEY, fresh);
    return fresh;
  } catch {
    return "anonymous";
  }
}

function ThinkingBubble() {
  return (
    <div className="card-glow rise-in flex items-center gap-3 rounded-2xl rounded-bl-md border-l-2 border-l-sf-blue-bright px-5 py-4">
      <div className="flex gap-1.5">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="thinking-dot h-1.5 w-1.5 rounded-full bg-sf-blue-glow"
            style={{ animationDelay: `${i * 0.16}s` }}
          />
        ))}
      </div>
      <span className="text-sm text-[#8b9bb8]">Searching the documentation…</span>
    </div>
  );
}

export default function Chat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);

  const scrollAnchor = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    scrollAnchor.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isLoading]);

  // Grow the composer with its content, up to a ceiling.
  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  async function ask(question: string) {
    const trimmed = question.trim();
    if (!trimmed || isLoading) return;

    setMessages((prev) => [...prev, { id: nextId(), role: "user", content: trimmed }]);
    setInput("");
    setIsLoading(true);

    try {
      const response = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed, sessionId: getSessionId() }),
      });

      const data: {
        answer?: string;
        sources?: Source[];
        error?: string;
        remaining?: number;
      } = await response.json().catch(() => ({}));

      if (!response.ok || data.error) {
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: "assistant",
            content: data.error ?? "Something went wrong. Try again.",
            isError: true,
          },
        ]);
        return;
      }

      if (typeof data.remaining === "number") setRemaining(data.remaining);

      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          role: "assistant",
          content: data.answer ?? "",
          sources: data.sources ?? [],
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          role: "assistant",
          content: "Couldn't reach the agent — check your connection and try again.",
          isError: true,
        },
      ]);
    } finally {
      setIsLoading(false);
      textarea.current?.focus();
    }
  }

  const isEmpty = messages.length === 0;

  return (
    <section className="mx-auto w-full max-w-3xl px-6 pb-16">
      {isEmpty ? (
        <div className="mb-6">
          <p className="mb-3 text-center text-xs font-medium uppercase tracking-[0.14em] text-[#7e90b0]">
            Try one of these
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {SAMPLE_QUESTIONS.map((question) => (
              <button
                key={question}
                onClick={() => ask(question)}
                disabled={isLoading}
                className="rounded-full border border-[rgba(87,163,253,0.22)] bg-[rgba(255,255,255,0.03)] px-4 py-2 text-sm text-[#b6c5de] transition-all hover:border-[rgba(87,163,253,0.5)] hover:bg-[rgba(87,163,253,0.1)] hover:text-white disabled:opacity-50"
              >
                {question}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="mb-6 space-y-5">
          {messages.map((message) => (
            <Message key={message.id} message={message} />
          ))}
          {isLoading && <ThinkingBubble />}
          <div ref={scrollAnchor} />
        </div>
      )}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          ask(input);
        }}
        className="card-glow sticky bottom-5 rounded-2xl p-2 transition-shadow focus-within:card-glow-strong"
      >
        <div className="flex items-end gap-2">
          <textarea
            ref={textarea}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends; Shift+Enter inserts a newline.
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                ask(input);
              }
            }}
            rows={1}
            maxLength={1000}
            disabled={isLoading}
            placeholder="Ask a Salesforce question…"
            aria-label="Ask a Salesforce question"
            className="max-h-40 flex-1 resize-none bg-transparent px-3 py-2.5 text-[0.9375rem] text-[#e8edf7] placeholder:text-[#5f7095] focus:outline-none disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            aria-label="Send question"
            className="mb-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sf-blue-bright text-white shadow-[0_0_20px_-4px_rgba(27,150,255,0.7)] transition-all hover:bg-[#3ba6ff] hover:shadow-[0_0_26px_-2px_rgba(27,150,255,0.85)] disabled:cursor-not-allowed disabled:bg-[rgba(87,163,253,0.16)] disabled:text-[#5f7095] disabled:shadow-none"
          >
            <svg
              viewBox="0 0 20 20"
              className="h-4.5 w-4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M10 16V4M4.5 9.5 10 4l5.5 5.5" />
            </svg>
          </button>
        </div>
      </form>

      <p className="mt-4 text-center text-xs text-[#5f7095]">
        {remaining !== null && remaining <= 5
          ? `${remaining} question${remaining === 1 ? "" : "s"} left this hour · `
          : ""}
        Answers are generated and may be imperfect — follow the citations.
      </p>
    </section>
  );
}
