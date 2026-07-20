/**
 * Citation-parser regression tests.
 *
 *   node --test --experimental-strip-types lib/parse.test.mjs
 *
 * The case that matters most is `(Source: https://…)` — the format the live
 * agent actually emits. See the "real webhook payload" test for a verbatim
 * response captured from the n8n webhook.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { extractOutput, parseAnswer } from "./parse.ts";

const REAL_WEBHOOK_PAYLOAD = {
  output:
    "To authenticate... Use the access token in the Authorization header for your API requests (Source: https://developer.salesforce.com/docs/atlas.en-us.agentforce_it_service_dev_guide.meta/agentforce_it_service_dev_guide/graphql_api_authentication.htm).\n\n2. User Sign-In:\n... (Source: https://developer.salesforce.com/docs/atlas.en-us.agentforce_it_service_dev_guide.meta/agentforce_it_service_dev_guide/graphql_api_authentication_user_interactive_oauth.htm).\n\nChoose the method that best fits your use case.",
};

test("real webhook payload: both (Source: …) citations become sources", () => {
  const output = extractOutput(REAL_WEBHOOK_PAYLOAD);
  assert.ok(output, "extractOutput should find the answer under `output`");

  const { answer, sources, urlsFound } = parseAnswer(output);

  assert.equal(sources.length, 2);
  assert.equal(urlsFound, 2);
  assert.deepEqual(
    sources.map((s) => s.n),
    [1, 2],
  );
  assert.match(sources[0].url, /graphql_api_authentication\.htm$/);
  assert.equal(sources[0].host, "developer.salesforce.com");

  // The "(Source: …)" wrapper is consumed, not left stranded around the marker.
  assert.doesNotMatch(answer, /\(Source:/i);
  assert.doesNotMatch(answer, / {2}/, "no doubled spaces where the URL was");
  assert.match(answer, /API requests \[\[1\]\]\(https:\/\/developer\.salesforce\.com/);
});

test("bare parenthesised URL still parses", () => {
  const { sources } = parseAnswer(
    "See the guide (https://help.salesforce.com/s/articleView?id=sf.leads.htm&language=en_US).",
  );
  assert.equal(sources.length, 1);
  assert.equal(sources[0].host, "help.salesforce.com");
});

test("markdown-link citations are collected, and the link is left intact", () => {
  const raw = "See [the docs](https://developer.salesforce.com/docs/foo.htm) for details.";
  const { answer, sources } = parseAnswer(raw);
  assert.equal(sources.length, 1, "markdown links must not be silently dropped");
  assert.equal(answer, raw, "the link markup itself is untouched");
});

test("duplicate URLs dedupe to one numbered source", () => {
  const url = "https://developer.salesforce.com/docs/foo.htm";
  const { answer, sources } = parseAnswer(`First (Source: ${url}). Again (Source: ${url}).`);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].n, 1);
  assert.equal(answer.match(/\[\[1\]\]/g)?.length, 2, "both mentions reuse marker 1");
});

test("several URLs inside one parenthesis all register", () => {
  const { sources } = parseAnswer(
    "Both (Source: https://developer.salesforce.com/docs/a.htm, https://developer.salesforce.com/docs/b.htm).",
  );
  assert.equal(sources.length, 2);
});

test("non-documentation URLs are not sources, but do count as URLs", () => {
  const { answer, sources, urlsFound } = parseAnswer(
    "POST to (Source: https://login.salesforce.com/services/oauth2/token).",
  );
  assert.equal(sources.length, 0, "an OAuth endpoint is not a citation");
  assert.equal(urlsFound, 1, "…but the answer is not citation-free either");
  assert.match(answer, /login\.salesforce\.com/, "left in the prose as written");
});

test("a genuinely ungrounded answer reports no URLs at all", () => {
  const { sources, urlsFound } = parseAnswer(
    "The indexed documentation doesn't cover that topic.",
  );
  assert.equal(sources.length, 0);
  assert.equal(urlsFound, 0, "this is the only state that earns the disclaimer");
});

test("trailing sentence punctuation is trimmed off the URL", () => {
  const { sources } = parseAnswer(
    "See https://developer.salesforce.com/docs/foo.htm, then continue.",
  );
  assert.equal(sources.length, 1);
  assert.equal(sources[0].url, "https://developer.salesforce.com/docs/foo.htm");
});

test("titles are derived from the last path segment", () => {
  const { sources } = parseAnswer(
    "(Source: https://developer.salesforce.com/docs/sforce_api_calls_convertlead.htm)",
  );
  assert.equal(sources[0].title, "Sforce Api Calls Convertlead");
});

test("extractOutput handles the array-wrapped webhook shape", () => {
  assert.equal(extractOutput([{ output: "hello" }]), "hello");
  assert.equal(extractOutput({ data: { answer: "hi" } }), "hi");
  assert.equal(extractOutput({ nothing: 1 }), null);
});
