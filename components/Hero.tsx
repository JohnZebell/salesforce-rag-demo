export default function Hero() {
  return (
    <header className="mx-auto max-w-3xl px-6 pt-16 pb-10 text-center sm:pt-24">
      <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-[rgba(87,163,253,0.28)] bg-[rgba(87,163,253,0.08)] px-3.5 py-1.5 text-xs font-medium text-[#8dc2ff]">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full rounded-full bg-sf-blue-bright opacity-70" />
        </span>
        Retrieval-augmented · grounded in official docs
      </div>

      <h1 className="text-balance text-4xl font-semibold tracking-tight text-white sm:text-5xl">
        Ask the Salesforce docs
        <span className="block bg-gradient-to-r from-[#57a3fd] to-[#1b96ff] bg-clip-text text-transparent">
          anything.
        </span>
      </h1>

      <p className="mx-auto mt-6 max-w-2xl text-pretty text-base leading-relaxed text-[#a9b8d4] sm:text-lg">
        A retrieval agent grounded in roughly{" "}
        <strong className="font-semibold text-[#dbe4f3]">24,000 pages</strong> of official
        Salesforce documentation. It searches the corpus before answering, cites the sources
        it used, and tells you plainly when the docs don&apos;t cover something — instead of
        guessing.
      </p>

      <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-[#7e90b0]">
        <span>No sign-in</span>
        <span aria-hidden className="text-[#31406a]">
          ·
        </span>
        <span>Nothing is saved</span>
        <span aria-hidden className="text-[#31406a]">
          ·
        </span>
        <span>Every claim linked to a source</span>
      </div>
    </header>
  );
}
