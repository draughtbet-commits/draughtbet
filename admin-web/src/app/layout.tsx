import type { Metadata } from 'next';
import { Manrope, Fraunces, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { AuthProvider } from '@/lib/auth/AuthContext';

const manrope = Manrope({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap'
});

const fraunces = Fraunces({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap'
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap'
});

export const metadata: Metadata = {
  title: 'Draught Bet Admin Console',
  description: 'Operational control plane for Draught Bet platform'
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${manrope.variable} ${fraunces.variable} ${jetbrainsMono.variable} h-full antialiased dark`}
    >
      <body className="min-h-full bg-[#000000] text-[#F5F7FA] font-sans">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
