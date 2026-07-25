import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "uniFind",
  description: "Find university courses you qualify for, free.",
};

// No next/font here -- the report page at /r/[token] is read on a
// mid-range Android on the learner's own data, and a webfont download
// isn't worth the bytes for text. The system font stack in globals.css
// applies everywhere.
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
