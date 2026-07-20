"""
Salesforce Docs Ingestion Script (incremental + resumable)
==========================================================
Scrapes Salesforce documentation and ingests it into a single `salesforce_docs`
Qdrant collection, so the "Salesforce Ops" agent can retrieve grounded answers
exactly like the HubSpot / GHL agents.

Chunking, payload schema, point-id scheme and the embed/upsert calls are
UNCHANGED from the original. What changed is the FLOW:

  BEFORE:  render ALL pages -> chunk ALL -> embed/upsert at the very end.
           A browser crash at page 420 lost every rendered page (only 15
           points ever reached Qdrant).

  NOW:     render a window of pages -> chunk -> embed -> upsert -> repeat.
           A crash costs at most FLUSH_EVERY_PAGES pages of work.

Three mechanisms make a restart cheap:

  1. INCREMENTAL FLUSH (FLUSH_EVERY_PAGES) — work lands in Qdrant continuously.
  2. RESUME (scroll the collection for `url` payloads) — already-embedded URLs
     are skipped on startup, so a rerun picks up where it stopped.
  3. BROWSER RECYCLING (RESTART_EVERY_PAGES) — the Chromium process is torn
     down and relaunched periodically, and immediately on a lost-target error,
     so per-process memory growth never reaches the OOM killer.

Pages that render but yield nothing (fetch error, or under the 100-char floor
in chunk_markdown_doc) never produce a point, so Qdrant can't record them as
done. They're tracked in SKIPPED_URLS_FILE instead — otherwise every restart
would re-render the same dead pages forever. Delete that file (or set
RETRY_SKIPPED = True) to give them another chance.

TWO sources go into the ONE collection, distinguished by the `kind` payload field:
  - kind="help"       -> help.salesforce.com        (end-user CRM usage docs)
  - kind="developer"  -> developer.salesforce.com   (APIs, Apex, SOQL, dev guides)

Deps:     pip install requests beautifulsoup4 markdownify playwright
          playwright install chromium
Secrets:  export QDRANT_API_KEY=...  and  export OPENAI_API_KEY=...
          (see the note at the bottom of this docstring)

Usage:
    python ingest_salesforce_docs.py              # resume (default)
    python ingest_salesforce_docs.py --restart    # ignore Qdrant, re-render all
    python ingest_salesforce_docs.py --refresh-sitemaps   # re-expand sitemaps
    python ingest_salesforce_docs.py --status     # print progress, do nothing

NOTE ON SECRETS: the original hardcoded both API keys as literals. They're read
from the environment here so the file can live in a git repo without leaking a
live OpenAI key. Both keys were exposed in a chat transcript — rotate them.
"""

import os
import re
import sys
import json
import time
import asyncio
import hashlib
import requests
from typing import List, Dict, Set, Optional, Tuple

from bs4 import BeautifulSoup
try:
    from markdownify import markdownify as _md
except Exception:  # markdownify optional; fall back to plain text
    _md = None

# =============================================================================
# CONFIG
# =============================================================================

QDRANT_URL = "http://159.203.86.200:6333"
QDRANT_API_KEY = os.environ.get("QDRANT_API_KEY", "")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
EMBEDDING_MODEL = "text-embedding-3-small"
EMBEDDING_DIMS = 1536

DOCS_COLLECTION = "salesforce_docs"

# Chunking / batching — identical to the original
MAX_CHARS = 24000
EMBED_BATCH_SIZE = 50

# --- crash-resilience knobs --------------------------------------------------
# Pages rendered before chunks are embedded + upserted. This is the blast radius
# of a crash: lose at most this many pages of rendering work.
FLUSH_EVERY_PAGES = 25

# Pages rendered before Chromium is torn down and relaunched. The browser is
# also relaunched immediately whenever a lost-target error is detected, so this
# is the proactive half of the defence.
RESTART_EVERY_PAGES = 200

# Concurrent headless Chromium pages.
#
# This was 4. On a 1vcpu-2gb droplet four concurrent Salesforce pages (each a
# heavy JS SPA) is what drives the resident set into the OOM killer, which
# Playwright then reports as "TargetClosedError: Target page, context or browser
# has been closed". 2 is the safe value for this box; raise it if you move to a
# larger droplet, and watch `dmesg -T | grep -i oom` if you do.
RENDER_WORKERS = 2

RENDER_TIMEOUT_MS = 45000        # per-page navigation timeout
RENDER_SETTLE_MS = 1200          # extra wait after networkidle for late content

# Chromium flags that matter on a small droplet. --disable-dev-shm-usage is the
# important one: /dev/shm defaults to 64MB and Chromium will crash without it.
CHROMIUM_ARGS = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
]

# --- resume state ------------------------------------------------------------
STATE_DIR = os.path.dirname(os.path.abspath(__file__))
SITEMAP_CACHE_FILE = os.path.join(STATE_DIR, "salesforce_sitemap_urls.json")
SKIPPED_URLS_FILE = os.path.join(STATE_DIR, "salesforce_skipped_urls.json")

# Re-attempt pages that previously rendered empty or errored.
RETRY_SKIPPED = False

# How many points to pull per Qdrant scroll request when rebuilding the done-set.
SCROLL_PAGE_SIZE = 1000

# --- staged run controls -----------------------------------------------------
TEST_MODE = False
TEST_LIMIT_PER_SOURCE = 15
PRIORITY_SUBSTRINGS = ["lead", "opportunity", "apex", "soql", "flow"]

# =============================================================================
# SOURCES — the two doc sites, each -> a `kind`, both -> DOCS_COLLECTION
# =============================================================================
HELP_PRODUCT_TYPES = ["sales", "service", "platform", "data"]  # e.g. + "mktg", "ai", ...

HELP_SITEMAPS = [
    f"https://help.salesforce.com/apex/Help_SiteMapIndexExternal?producttype={pt}"
    for pt in HELP_PRODUCT_TYPES
]

DEVELOPER_SITEMAPS = [
    "https://developer.salesforce.com/docs-atlas-sitemap.xml",  # the atlas doc corpus
    "https://developer.salesforce.com/docs/ssg-sitemap.xml",
]

SOURCES = [
    {
        "name": "help",
        "kind": "help",
        "sitemaps": HELP_SITEMAPS,
        "url_filter": lambda u: ("language=en_us" in u.lower()) or ("/en-us/" in u.lower()),
        # NOTE: body_selectors / wait_selectors are consumed by extract_article(),
        # which the current renderer bypasses in favour of the shadow-DOM-aware
        # page.evaluate() walk in _render_one. Kept because they're the config you
        # tune if you ever switch extraction back. See _render_one for what runs.
        "body_selectors": [
            {"attrs": {"itemprop": "articleBody"}},
            {"class_": "slds-rich-text-editor__output"},
            {"name": "article"},
            {"attrs": {"role": "main"}},
            {"name": "main"},
        ],
        "wait_selectors": ["[itemprop=articleBody]", "article", "main"],
    },
    {
        "name": "developer",
        "kind": "developer",
        "sitemaps": DEVELOPER_SITEMAPS,
        "url_filter": lambda u: ((".en-us." in u.lower()) or ("/en-us/" in u.lower())) and not any(b in u.lower() for b in ["apexcode","apexref","apex_","pages.meta","pages/","lightning","aura","componentref","lwc","mobile_sdk","visualforce","code_sample","api_meta","api_tooling"]),
        "body_selectors": [
            {"id": "content"},
            {"attrs": {"role": "main"}},
            {"name": "article"},
            {"class_": "content"},
            {"name": "main"},
        ],
        "wait_selectors": ["#content", "article", "main"],
    },
]

# =============================================================================
# STEP 1: SOURCE LIST — recursively expand nested sitemap indexes
#   Cached to disk: sitemap expansion launches a browser per index and is slow,
#   and a resumed run would otherwise repeat the whole crawl just to rebuild a
#   list it already had.
# =============================================================================

def _locs(xml_text: str) -> List[str]:
    return re.findall(r"<loc>\s*(.*?)\s*</loc>", xml_text, flags=re.IGNORECASE | re.DOTALL)

def expand_sitemap(url: str, seen: set, depth: int = 0) -> List[str]:
    """Fetch a sitemap URL; recurse into <sitemapindex> children; return page URLs."""
    if url in seen or depth > 4:
        return []
    seen.add(url)
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=CHROMIUM_ARGS)
            page = browser.new_page()
            page.goto(url, wait_until="domcontentloaded", timeout=60000)
            text = page.content()
            browser.close()
    except Exception as e:
        print(f"    [warn] sitemap fetch failed {url}: {e}")
        return []
    locs = _locs(text)
    is_index = "<sitemapindex" in text.lower()

    if is_index:
        pages: List[str] = []
        for child in locs:
            pages.extend(expand_sitemap(child, seen, depth + 1))
        return pages
    # urlset — these are page URLs (but some children may still be .xml)
    pages = []
    for loc in locs:
        if loc.lower().endswith(".xml"):
            pages.extend(expand_sitemap(loc, seen, depth + 1))
        else:
            pages.append(loc)
    return pages

def collect_source_urls(source: Dict) -> List[Dict]:
    print(f"\n[sitemap] {source['name']}: expanding {len(source['sitemaps'])} index(es)...")
    seen: set = set()
    all_pages: List[str] = []
    for sm in source["sitemaps"]:
        all_pages.extend(expand_sitemap(sm, seen))
    # de-dup + English/article filter
    uniq = list(dict.fromkeys(all_pages))
    filtered = [u for u in uniq if source["url_filter"](u)]
    print(f"  [ok] {len(uniq)} urls -> {len(filtered)} after english/article filter")

    items = [{"url": u, "kind": source["kind"]} for u in filtered]

    if TEST_MODE:
        priority = [it for it in items
                    if any(s in it["url"].lower() for s in PRIORITY_SUBSTRINGS)]
        prio_urls = {it["url"] for it in priority}
        rest = [it for it in items if it["url"] not in prio_urls]
        items = (priority + rest)[:TEST_LIMIT_PER_SOURCE]
        print(f"  [test-mode] limiting {source['name']} to {len(items)} pages "
              f"({len(priority)} priority + fill)")
    return items

def load_all_items(refresh: bool = False) -> List[Dict]:
    """The full work-list, from cache when available."""
    if not refresh and not TEST_MODE and os.path.exists(SITEMAP_CACHE_FILE):
        try:
            with open(SITEMAP_CACHE_FILE, "r", encoding="utf-8") as f:
                items = json.load(f)
            if items:
                print(f"[sitemap] loaded {len(items)} urls from cache "
                      f"({os.path.basename(SITEMAP_CACHE_FILE)}) — "
                      f"pass --refresh-sitemaps to re-crawl")
                return items
        except Exception as e:
            print(f"[warn] sitemap cache unreadable ({e}); re-crawling")

    items: List[Dict] = []
    for source in SOURCES:
        items.extend(collect_source_urls(source))

    # de-dup across sources, preserving order
    seen_urls: Set[str] = set()
    deduped = []
    for it in items:
        if it["url"] not in seen_urls:
            seen_urls.add(it["url"])
            deduped.append(it)

    if deduped and not TEST_MODE:
        try:
            with open(SITEMAP_CACHE_FILE, "w", encoding="utf-8") as f:
                json.dump(deduped, f)
            print(f"[sitemap] cached {len(deduped)} urls -> "
                  f"{os.path.basename(SITEMAP_CACHE_FILE)}")
        except Exception as e:
            print(f"[warn] could not write sitemap cache: {e}")
    return deduped

# =============================================================================
# RESUME STATE — which URLs are already done?
# =============================================================================

def fetch_embedded_urls(collection: str) -> Set[str]:
    """Scroll the collection and collect every distinct `url` payload value.

    This is the resume set: any URL with at least one point in Qdrant has
    already been rendered, chunked and upserted, so it's skipped.
    """
    urls: Set[str] = set()
    offset = None
    pages = 0
    print(f"\n[resume] scanning {collection} for already-embedded urls...")
    while True:
        body = {
            "limit": SCROLL_PAGE_SIZE,
            "with_payload": ["url"],
            "with_vector": False,
        }
        if offset is not None:
            body["offset"] = offset
        try:
            r = requests.post(
                f"{QDRANT_URL}/collections/{collection}/points/scroll",
                headers=qdrant_headers(),
                json=body,
                timeout=60,
            )
        except Exception as e:
            print(f"  [warn] scroll failed ({e}); treating collection as empty")
            return urls
        if r.status_code == 404:
            print("  [ok] collection not found yet — nothing to resume from")
            return urls
        if r.status_code != 200:
            print(f"  [warn] scroll returned {r.status_code}: {r.text[:200]}")
            return urls

        result = r.json().get("result", {}) or {}
        points = result.get("points", []) or []
        for p in points:
            u = (p.get("payload") or {}).get("url")
            if u:
                urls.add(u)
        pages += 1
        offset = result.get("next_page_offset")
        if not points or offset is None:
            break

    print(f"  [ok] {len(urls)} urls already embedded ({pages} scroll page(s))")
    return urls

def load_skipped_urls() -> Set[str]:
    """URLs that rendered empty/errored — they never produce a Qdrant point, so
    without this they'd be re-rendered on every single restart."""
    if RETRY_SKIPPED or not os.path.exists(SKIPPED_URLS_FILE):
        return set()
    try:
        with open(SKIPPED_URLS_FILE, "r", encoding="utf-8") as f:
            return set(json.load(f))
    except Exception as e:
        print(f"[warn] skipped-urls file unreadable ({e}); ignoring")
        return set()

def save_skipped_urls(urls: Set[str]):
    try:
        with open(SKIPPED_URLS_FILE, "w", encoding="utf-8") as f:
            json.dump(sorted(urls), f)
    except Exception as e:
        print(f"[warn] could not write skipped-urls file: {e}")

# =============================================================================
# STEP 2: FETCH + RENDER (headless Chromium) + EXTRACT
# =============================================================================

STRIP_TAGS = ["script", "style", "nav", "header", "footer", "form", "noscript", "svg"]

# Substrings that mean "the browser process is gone" rather than "this page
# failed" — these trigger an immediate relaunch instead of being counted as a
# per-page failure.
DEAD_BROWSER_MARKERS = (
    "target page, context or browser has been closed",
    "targetclosederror",
    "browser has been closed",
    "connection closed",
    "browser closed",
)

def _is_dead_browser(err: Optional[str]) -> bool:
    if not err:
        return False
    low = err.lower()
    return any(m in low for m in DEAD_BROWSER_MARKERS)

def _find_body(soup: BeautifulSoup, selectors: List[Dict]):
    for sel in selectors:
        if "id" in sel:
            node = soup.find(id=sel["id"])
        elif "class_" in sel:
            node = soup.find(class_=sel["class_"])
        elif "attrs" in sel:
            node = soup.find(attrs=sel["attrs"])
        else:
            node = soup.find(sel["name"])
        if node:
            return node
    return None

def _largest_text_block(soup: BeautifulSoup):
    """Fallback when no selector matches: the div/article/section/main with the
    most text. Guards against JS pages whose body container we didn't anticipate."""
    best, best_len = None, 0
    for node in soup.find_all(["article", "main", "section", "div"]):
        txt = node.get_text(" ", strip=True)
        if len(txt) > best_len:
            best, best_len = node, len(txt)
    return best if best_len > 400 else None

def extract_article(html: str, selectors: List[Dict]) -> Dict[str, Optional[str]]:
    """Selector-based extraction. Currently unused — _render_one extracts inside
    the page instead (it has to pierce shadow roots). Kept as the fallback path."""
    soup = BeautifulSoup(html, "html.parser")

    title = None
    og = soup.find("meta", attrs={"property": "og:title"})
    if og and og.get("content"):
        title = og["content"].strip()
    if not title and soup.title and soup.title.string:
        title = soup.title.string.strip()

    description = ""
    for sel in ({"name": "description"}, {"property": "og:description"}):
        m = soup.find("meta", attrs=sel)
        if m and m.get("content"):
            description = m["content"].strip()
            break

    body = _find_body(soup, selectors) or _largest_text_block(soup)
    if body is None:
        return {"title": title, "description": description, "content": None}

    for tag in body.find_all(STRIP_TAGS):
        tag.decompose()

    if _md is not None:
        content = _md(str(body), heading_style="ATX", strip=["img"]).strip()
    else:
        content = body.get_text("\n").strip()
    content = re.sub(r"\n{3,}", "\n\n", content)  # collapse blank-line runs

    return {"title": title, "description": description, "content": content}

DEEP_TEXT_JS = """() => {
    const root = document.querySelector('#maincontent') || document.querySelector('main') || document.body;
    const nl = String.fromCharCode(10);
    function getDeepText(node) {
        if (!node) return "";
        if (node.nodeType === 3) {
            return node.nodeValue;
        }
        const tag = node.tagName ? node.tagName.toLowerCase() : "";
        if (["script", "style", "nav", "header", "footer", "noscript"].includes(tag)) {
            return "";
        }
        let childrenText = "";
        if (node.childNodes) {
            for (let child of node.childNodes) {
                childrenText += getDeepText(child);
            }
        }
        if (node.shadowRoot) {
            for (let child of node.shadowRoot.childNodes) {
                childrenText += getDeepText(child);
            }
        }
        if (["h1", "h2", "h3", "h4", "h5", "h6", "p", "div", "section", "tr", "li"].includes(tag)) {
            return childrenText + nl;
        }
        return childrenText;
    }
    return getDeepText(root).split(nl).map(line => line.trim()).filter(line => line.length > 0).join(nl + nl);
}"""

async def _render_one(context, item: Dict, sem: asyncio.Semaphore) -> Dict:
    """Render one page. Never raises — failures come back as `error` so one bad
    page can't take down the window."""
    title = ""
    deep_content = None
    error_msg = "no-body"

    async with sem:
        page = None
        try:
            page = await context.new_page()
            await page.goto(item["url"], timeout=60000, wait_until="domcontentloaded")
            for target_selector in ["doc-content", "doc-xml-content", "#maincontent", "main"]:
                try:
                    await page.wait_for_selector(target_selector, timeout=3000)
                except Exception:
                    continue
            await page.wait_for_timeout(5000)
            title = await page.title()

            deep_content = await page.evaluate(DEEP_TEXT_JS)

            if deep_content and len(deep_content.strip()) > 50:
                error_msg = None
            else:
                deep_content = None
        except Exception as e:
            error_msg = str(e)
            deep_content = None
        finally:
            # page.close() itself throws when the target is already gone; that
            # exception must not mask the real error.
            if page is not None:
                try:
                    await page.close()
                except Exception:
                    pass

    return {
        "url": item["url"],
        "kind": item["kind"],
        "title": title or "Salesforce Documentation",
        "description": "",
        "content": deep_content,
        "error": error_msg,
    }

async def _launch_browser(p) -> Tuple[object, object]:
    browser = await p.chromium.launch(headless=True, args=CHROMIUM_ARGS)
    context = await browser.new_context(user_agent="Mozilla/5.0")
    return browser, context

async def _close_browser(browser, context):
    for closer in (context, browser):
        if closer is None:
            continue
        try:
            await closer.close()
        except Exception:
            pass

async def _render_window(context, window: List[Dict]) -> List[Dict]:
    """Render one flush-window. Tasks are created per window, not for the whole
    corpus — the original built every task upfront, which pinned thousands of
    coroutines in memory before the first page even loaded."""
    sem = asyncio.Semaphore(RENDER_WORKERS)
    tasks = [asyncio.create_task(_render_one(context, it, sem)) for it in window]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    docs = []
    for it, res in zip(window, results):
        if isinstance(res, BaseException):
            docs.append({
                "url": it["url"], "kind": it["kind"],
                "title": "Salesforce Documentation", "description": "",
                "content": None, "error": str(res),
            })
        else:
            docs.append(res)
    return docs

# =============================================================================
# STEP 3: CHUNK — unchanged
# =============================================================================

def chunk_markdown_doc(doc: Dict) -> List[Dict]:
    if not doc.get("content"):
        return []
    content = doc["content"].strip()
    if len(content) < 100:
        return []
    title = doc.get("title") or doc["url"]

    if len(content) <= MAX_CHARS:
        chunks = [{"heading": title, "content": content}]
    else:
        parts = re.split(r"(?m)^## ", content)
        chunks = []
        if parts[0].strip():
            chunks.append({"heading": "(intro)", "content": parts[0].strip()})
        for part in parts[1:]:
            nl = part.find("\n")
            heading = part[:nl].strip() if nl > 0 else "section"
            body = part[nl + 1:].strip() if nl > 0 else ""
            chunks.append({"heading": heading, "content": f"## {heading}\n\n{body}"})

    result = []
    for i, c in enumerate(chunks):
        text = c["content"][:MAX_CHARS]
        chunk_id = hashlib.md5(f"docs:{doc['url']}:{i}".encode()).hexdigest()
        embed_text = f"{title}\n\n{c['heading']}\n\n{text}"
        result.append({
            "id": chunk_id,
            "kind": doc["kind"],           # "help" or "developer"
            "title": title,
            "url": doc["url"],
            "section_heading": c["heading"],
            "chunk_index": i,
            "content": text,
            "embed_text": embed_text,
            "description": doc.get("description", "") or "",
        })
    return result

def build_doc_chunks(docs: List[Dict]) -> List[Dict]:
    all_chunks = []
    for doc in docs:
        all_chunks.extend(chunk_markdown_doc(doc))
    return all_chunks

# =============================================================================
# STEP 4: EMBED + UPSERT — same calls, same payload, same ids
# =============================================================================

def qdrant_headers():
    h = {"Content-Type": "application/json"}
    if QDRANT_API_KEY:
        h["api-key"] = QDRANT_API_KEY
    return h

def ensure_collection(name: str):
    r = requests.get(f"{QDRANT_URL}/collections/{name}", headers=qdrant_headers())
    if r.status_code == 200:
        existing_dims = r.json().get("result", {}).get("config", {}).get("params", {}).get("vectors", {}).get("size")
        if existing_dims and existing_dims != EMBEDDING_DIMS:
            raise RuntimeError(f"Collection {name} exists with wrong dims ({existing_dims}); expected {EMBEDDING_DIMS}")
        print(f"  [exists] {name} (left intact — pages will be added/updated)")
        return
    print(f"  [create] {name}")
    r = requests.put(
        f"{QDRANT_URL}/collections/{name}",
        headers=qdrant_headers(),
        json={"vectors": {"size": EMBEDDING_DIMS, "distance": "Cosine"}},
        timeout=30,
    )
    r.raise_for_status()

def embed_batch(texts: List[str]) -> List[List[float]]:
    safe = [t[:MAX_CHARS] for t in texts]
    r = requests.post(
        "https://api.openai.com/v1/embeddings",
        headers={"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"},
        json={"model": EMBEDDING_MODEL, "input": safe},
        timeout=120,
    )
    if r.status_code != 200:
        raise RuntimeError(f"OpenAI embed failed: {r.status_code} {r.text[:300]}")
    data = r.json()["data"]
    data.sort(key=lambda x: x["index"])
    return [d["embedding"] for d in data]

def upsert_batch(collection: str, points: List[Dict]):
    r = requests.put(
        f"{QDRANT_URL}/collections/{collection}/points?wait=true",
        headers=qdrant_headers(),
        json={"points": points},
        timeout=60,
    )
    if r.status_code != 200:
        raise RuntimeError(f"Qdrant upsert failed: {r.status_code} {r.text[:300]}")

def _batches_whole_urls(chunks: List[Dict], max_size: int) -> List[List[Dict]]:
    """Group chunks into batches without splitting a URL across two batches.

    Matters for resume correctness: the done-set is keyed on URL, so if a URL's
    chunks 0-2 upserted and 3-5 didn't, the restart would skip it and leave the
    page permanently half-indexed. Keeping a URL whole means it either fully
    lands or fully retries. A single URL with more than max_size chunks still
    gets its own oversized batch.
    """
    by_url: Dict[str, List[Dict]] = {}
    for c in chunks:
        by_url.setdefault(c["url"], []).append(c)

    batches: List[List[Dict]] = []
    current: List[Dict] = []
    for url_chunks in by_url.values():
        if current and len(current) + len(url_chunks) > max_size:
            batches.append(current)
            current = []
        current.extend(url_chunks)
        if len(current) >= max_size:
            batches.append(current)
            current = []
    if current:
        batches.append(current)
    return batches

def ingest_chunks(collection: str, chunks: List[Dict]) -> bool:
    """Embed + upsert one flush. Returns True if everything landed.

    Same embed call, same point-id scheme, same payload keys as before — only
    the batching boundary changed (see _batches_whole_urls).
    """
    if not chunks:
        return True

    ok = True
    for batch in _batches_whole_urls(chunks, EMBED_BATCH_SIZE):
        texts = [c["embed_text"] for c in batch]

        embeddings = None
        for attempt in range(3):
            try:
                embeddings = embed_batch(texts)
                break
            except Exception as e:
                wait = (attempt + 1) * 5
                print(f"    [retry] embed failed ({e}), wait {wait}s")
                time.sleep(wait)
        if embeddings is None:
            print("    [fail] embed batch exhausted retries — "
                  "these urls stay unmarked and will retry on the next run")
            ok = False
            continue

        points = []
        for chunk, vec in zip(batch, embeddings):
            cid = chunk["id"]
            point_uuid = f"{cid[0:8]}-{cid[8:12]}-{cid[12:16]}-{cid[16:20]}-{cid[20:32]}"
            # EXACT same payload keys as the hubspot_docs points
            payload = {
                "content": chunk["content"],
                "title": chunk["title"],
                "url": chunk["url"],
                "kind": chunk["kind"],
                "section_heading": chunk.get("section_heading", ""),
                "description": chunk.get("description", ""),
            }
            points.append({"id": point_uuid, "vector": vec, "payload": payload})

        upserted = False
        for attempt in range(3):
            try:
                upsert_batch(collection, points)
                upserted = True
                break
            except Exception as e:
                wait = (attempt + 1) * 5
                print(f"    [retry] upsert failed ({e}), wait {wait}s")
                time.sleep(wait)
        if not upserted:
            print("    [fail] upsert exhausted retries — will retry on the next run")
            ok = False

    return ok

# =============================================================================
# THE INCREMENTAL LOOP — render a window, flush it, repeat
# =============================================================================

class RunStats:
    def __init__(self, total: int):
        self.total = total
        self.rendered = 0
        self.embedded_pages = 0
        self.empty_pages = 0
        self.points = 0
        self.restarts = 0
        self.start = time.time()

    def line(self) -> str:
        el = time.time() - self.start
        rate = self.rendered / el if el else 0
        eta = (self.total - self.rendered) / rate if rate else 0
        return (f"[{self.rendered}/{self.total}] embedded={self.embedded_pages} "
                f"empty={self.empty_pages} points={self.points} "
                f"restarts={self.restarts} | {rate*60:.0f} pages/min | eta {eta/60:.0f}m")

async def run_incremental(items: List[Dict], collection: str, skipped: Set[str]) -> RunStats:
    from playwright.async_api import async_playwright

    stats = RunStats(len(items))
    windows = [items[i:i + FLUSH_EVERY_PAGES]
               for i in range(0, len(items), FLUSH_EVERY_PAGES)]

    async with async_playwright() as p:
        browser, context = await _launch_browser(p)
        since_restart = 0
        try:
            for w_index, window in enumerate(windows, 1):
                # Proactive recycle: tear Chromium down before its resident set
                # grows into the OOM killer.
                if since_restart >= RESTART_EVERY_PAGES:
                    print(f"  [browser] recycling after {since_restart} pages")
                    await _close_browser(browser, context)
                    browser, context = await _launch_browser(p)
                    since_restart = 0
                    stats.restarts += 1

                try:
                    docs = await _render_window(context, window)
                except Exception as e:
                    # The whole window blew up — almost always a dead browser.
                    print(f"  [browser] window {w_index} failed hard ({e}); relaunching")
                    await _close_browser(browser, context)
                    browser, context = await _launch_browser(p)
                    since_restart = 0
                    stats.restarts += 1
                    continue  # these urls stay unmarked; a rerun retries them

                stats.rendered += len(docs)
                since_restart += len(docs)

                good = [d for d in docs if d.get("content")]
                empty = [d for d in docs if not d.get("content")]

                # Reactive recycle: if the browser died mid-window, every page
                # after it reports the same lost-target error. Relaunch now
                # rather than burning the next window against a dead process.
                dead = [d for d in empty if _is_dead_browser(d.get("error"))]
                browser_alive = True
                try:
                    browser_alive = browser.is_connected()
                except Exception:
                    browser_alive = False
                if dead or not browser_alive:
                    print(f"  [browser] lost target ({len(dead)} page(s)); relaunching")
                    await _close_browser(browser, context)
                    browser, context = await _launch_browser(p)
                    since_restart = 0
                    stats.restarts += 1

                # FLUSH — this is the whole point of the refactor. Chunks are
                # embedded and upserted here, not thousands of pages later.
                chunks = build_doc_chunks(good)
                landed = ingest_chunks(collection, chunks) if chunks else True

                if landed:
                    stats.points += len(chunks)
                    stats.embedded_pages += len({c["url"] for c in chunks})

                # A page that rendered nothing produces no point, so Qdrant can
                # never mark it done. Record it here so restarts don't re-render
                # it forever. Pages killed by a dead browser are NOT recorded —
                # those deserve a retry.
                newly_skipped = {d["url"] for d in empty
                                 if not _is_dead_browser(d.get("error"))}
                # Rendered fine but fell under the 100-char floor in
                # chunk_markdown_doc: also permanently unmarkable.
                if landed:
                    chunked_urls = {c["url"] for c in chunks}
                    newly_skipped |= {d["url"] for d in good
                                      if d["url"] not in chunked_urls}
                if newly_skipped:
                    skipped |= newly_skipped
                    save_skipped_urls(skipped)
                    stats.empty_pages += len(newly_skipped)

                print(f"  {stats.line()}", flush=True)
        finally:
            await _close_browser(browser, context)

    return stats

# =============================================================================
# STEP 5: SANITY CHECK — unchanged
# =============================================================================

def sanity_check(collection: str, query: str):
    print(f"\n[sanity] {collection} <- '{query}'")
    qvec = embed_batch([query])[0]
    r = requests.post(
        f"{QDRANT_URL}/collections/{collection}/points/search",
        headers=qdrant_headers(),
        json={"vector": qvec, "limit": 4, "with_payload": True, "with_vector": False},
        timeout=30,
    )
    if r.status_code != 200:
        print(f"  [fail] {r.text[:300]}")
        return
    for i, res in enumerate(r.json().get("result", []), 1):
        p = res["payload"]
        print(f"  {i}. [{res['score']:.3f}] ({p.get('kind','?')}) {p.get('title', '?')} — {p.get('section_heading', '')}")
        print(f"     Source: {p.get('url', '')}")

# =============================================================================
# MAIN
# =============================================================================

def main():
    argv = sys.argv[1:]
    fresh_start = "--restart" in argv
    refresh_sitemaps = "--refresh-sitemaps" in argv
    status_only = "--status" in argv

    missing = [n for n, v in (("QDRANT_API_KEY", QDRANT_API_KEY),
                              ("OPENAI_API_KEY", OPENAI_API_KEY)) if not v]
    if missing:
        raise SystemExit(
            f"Missing env var(s): {', '.join(missing)}\n"
            f"  export QDRANT_API_KEY='...'\n"
            f"  export OPENAI_API_KEY='...'\n"
            f"(the values are the literals near the top of your previous copy of "
            f"this script — rotate them, they were pasted into a chat transcript)"
        )

    items = load_all_items(refresh=refresh_sitemaps)
    if not items:
        raise SystemExit("No source URLs collected — sitemap URLs or url_filter may need updating.")

    print("\n[qdrant] ensuring collection (create-if-missing only)...")
    ensure_collection(DOCS_COLLECTION)

    done = set() if fresh_start else fetch_embedded_urls(DOCS_COLLECTION)
    skipped = set() if fresh_start else load_skipped_urls()

    todo = [it for it in items if it["url"] not in done and it["url"] not in skipped]

    print(f"\n[plan] {len(items)} urls total")
    print(f"       {len(done)} already embedded (skipped)")
    print(f"       {len(skipped)} previously empty/failed (skipped — "
          f"set RETRY_SKIPPED=True or delete "
          f"{os.path.basename(SKIPPED_URLS_FILE)} to retry)")
    print(f"       {len(todo)} to render this run")
    print(f"       flush every {FLUSH_EVERY_PAGES} pages | "
          f"browser recycle every {RESTART_EVERY_PAGES} | "
          f"{RENDER_WORKERS} concurrent pages")

    if status_only:
        return

    if not todo:
        print("\n[done] nothing left to render — collection is fully populated.")
    else:
        stats = asyncio.run(run_incremental(todo, DOCS_COLLECTION, skipped))
        print(f"\n[ok] run finished in {(time.time()-stats.start)/60:.1f}m — "
              f"{stats.embedded_pages} pages embedded, {stats.points} points, "
              f"{stats.empty_pages} empty, {stats.restarts} browser restart(s)")
        remaining = stats.total - stats.rendered
        if remaining > 0:
            print(f"[note] {remaining} page(s) not reached this run — "
                  f"just rerun the script, it resumes from here")

    sanity_check(DOCS_COLLECTION, "how do I convert a lead into an opportunity")
    sanity_check(DOCS_COLLECTION, "how do I write a SOQL query in Apex")

    mode = "TEST batch" if TEST_MODE else "FULL"
    print(f"\n[done] Salesforce ingest ({mode}) -> {DOCS_COLLECTION} "
          f"(kinds: help + developer).")

if __name__ == "__main__":
    main()
