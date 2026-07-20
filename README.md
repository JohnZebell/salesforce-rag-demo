# Salesforce Ops RAG Agent
 
A retrieval-augmented (RAG) assistant grounded in tens of thousands of official Salesforce documentation pages. Ask it a real Salesforce question, it gives you a real answer, cites the exact docs it pulled from, and tells you when the docs don't actually cover something instead of making it up.
 
**Live demo:** [your-vercel-url-here]
 
---
 
## What it does
 
- **Grounded answers with citations.** Every claim is backed by a source link to the actual Salesforce documentation. No hand-wavy "trust me" answers.
- **Honest about its limits.** When the retrieved docs don't cover a question, it says so plainly rather than hallucinating a confident wrong answer. That honest-uncertainty behavior is the point, not a side effect.
- **Focused on the admin / RevOps / integration side of Salesforce** (data model, objects and relationships, validation and duplicate rules, picklists, data loading, SOQL, the APIs, and integration behavior). The developer-only coding docs (Apex, Visualforce) are deliberately filtered out to keep retrieval sharp for the operations use case.
## Why I built it
 
Every expert was a novice first. That's not a weakness, it's the path. The only real problem with being new to a platform is being slow, having to stop and dig through documentation every time you hit something you haven't seen.
 
So I removed that part. This agent lets me ramp on Salesforce in days instead of months by putting grounded, sourced answers one question away. My years of experience matter a lot less when I can perform at the level of someone who has them.
 
## How it works
 
- **Frontend** (this repo): Next.js 15 + TypeScript + Tailwind. A no-login public chat UI. The webhook URL is proxied server-side so it isn't exposed to the client, and requests are rate-limited per visitor.
- **Retrieval + generation**: an n8n workflow embeds the question, runs a vector search over the Salesforce doc corpus, and generates a grounded answer with a strict cite-your-sources / admit-when-unsure prompt.
- **Vector store**: Qdrant (OpenAI text-embedding-3-small, 1536 dims), self-hosted.
- **Corpus**: official Salesforce documentation, scraped (headless-rendered, since the docs are JS/Shadow-DOM heavy), chunked, and embedded. Filtered to the operations-relevant docs.
This frontend is one agent in a larger multi-agent CRM knowledge system (GoHighLevel, HubSpot, Salesforce). Only the frontend is public here; the retrieval pipeline and infrastructure are private.
 
## A note on the live demo
 
This runs on a personal API budget. If answers aren't loading, the demo has likely hit its usage cap for the period, come back another time. The architecture stands on its own regardless.


