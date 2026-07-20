import { NextResponse } from "next/server";
import { checkRateLimit, clientIpFrom, rateLimitConfig } from "@/lib/rate-limit";
import { extractOutput, parseAnswer } from "@/lib/parse";

// Keep the module-level rate-limit map alive across requests on a warm instance.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_QUESTION_LENGTH = 1000;
const UPSTREAM_TIMEOUT_MS = 30_000;

export async function POST(request: Request) {
  const webhookUrl = process.env.N8N_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error("N8N_WEBHOOK_URL is not set");
    return NextResponse.json(
      { error: "The agent isn't configured yet. Set N8N_WEBHOOK_URL and redeploy." },
      { status: 500 },
    );
  }

  let question: unknown;
  let sessionId: unknown;
  try {
    const body = await request.json();
    question = body?.message;
    sessionId = body?.sessionId;
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  if (typeof question !== "string" || !question.trim()) {
    return NextResponse.json({ error: "Ask a question first." }, { status: 400 });
  }

  if (question.length > MAX_QUESTION_LENGTH) {
    return NextResponse.json(
      { error: `Questions are capped at ${MAX_QUESTION_LENGTH} characters.` },
      { status: 400 },
    );
  }

  const limit = checkRateLimit(clientIpFrom(request.headers));
  if (!limit.ok) {
    const minutes = Math.ceil(limit.retryAfterSeconds / 60);
    return NextResponse.json(
      {
        error:
          limit.reason === "cooldown"
            ? `Just a moment — you can ask again in ${limit.retryAfterSeconds}s.`
            : `You've reached the demo limit of ${rateLimitConfig.MAX} questions per hour. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        retryAfterSeconds: limit.retryAfterSeconds,
      },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  try {
    const upstream = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // sessionId is sent so the n8n workflow can scope its conversation memory
      // per visitor. Until the workflow keys its memory node on this value, all
      // visitors share one thread — see README, "Shared conversation memory".
      body: JSON.stringify({
        message: question.trim(),
        sessionId: typeof sessionId === "string" ? sessionId.slice(0, 64) : undefined,
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    if (!upstream.ok) {
      console.error(`n8n responded ${upstream.status}`);
      return NextResponse.json(
        { error: `The agent returned an error (${upstream.status}). Try again shortly.` },
        { status: 502 },
      );
    }

    // n8n occasionally responds with a non-JSON body; fall back to raw text
    // rather than surfacing a parse error to the visitor.
    const raw = await upstream.text();
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = raw;
    }

    const output = extractOutput(payload);
    if (!output) {
      console.error("Could not find an answer in the n8n payload", raw.slice(0, 500));
      return NextResponse.json(
        { error: "The agent replied in an unexpected format." },
        { status: 502 },
      );
    }

    return NextResponse.json({ ...parseAnswer(output), remaining: limit.remaining });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    console.error("Upstream request failed", error);
    return NextResponse.json(
      {
        error: timedOut
          ? "The agent took too long to respond. Try a more specific question."
          : "Couldn't reach the agent. Try again shortly.",
      },
      { status: 504 },
    );
  }
}
