import Hero from "@/components/Hero";
import Chat from "@/components/Chat";

export default function Page() {
  return (
    <main className="flex min-h-screen flex-col">
      <Hero />
      <Chat />
      <footer className="mt-auto border-t border-[rgba(87,163,253,0.1)] px-6 py-6 text-center text-xs text-[#4c5f85]">
        Not affiliated with Salesforce. Documentation belongs to its respective owners.
      </footer>
    </main>
  );
}
