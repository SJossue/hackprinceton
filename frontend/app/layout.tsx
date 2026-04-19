import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Recall — your home, quietly remembered",
  description: "Where did I leave my keys? Did I take my pills? Your home remembers. Just ask.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
