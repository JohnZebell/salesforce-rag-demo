import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Salesforce Docs Agent — grounded answers with sources",
  description:
    "Ask anything about Salesforce. A retrieval agent grounded in ~24,000 pages of official documentation that cites every source and tells you when the docs don't cover something.",
  openGraph: {
    title: "Salesforce Docs Agent",
    description:
      "Grounded answers from ~24,000 pages of Salesforce documentation, with citations.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen font-sans antialiased">{children}</body>
    </html>
  );
}
