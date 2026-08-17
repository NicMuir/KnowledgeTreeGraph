import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'KB — Engineering Knowledge Base',
  description: 'AI-powered multi-repository knowledge base for engineering teams',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
