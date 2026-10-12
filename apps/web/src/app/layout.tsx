import type { Metadata, Viewport } from 'next';
import { Bodoni_Moda, Inter } from 'next/font/google';
import { Footer } from '@/components/layout/Footer';
import { MobileNav } from '@/components/layout/MobileNav';
import { SandboxBanner } from '@/components/layout/SandboxBanner';
import { SiteHeader } from '@/components/layout/SiteHeader';
import './globals.css';

// Open-licensed (SIL OFL) webfonts until the final brand fonts are chosen (D01): a high-contrast Bodoni-style display
// serif for editorial headings and a neutral UI sans whose latin-ext subset carries the naira sign (₦).
const ui = Inter({ subsets: ['latin', 'latin-ext'], variable: '--font-ui', display: 'swap' });
const display = Bodoni_Moda({ subsets: ['latin', 'latin-ext'], variable: '--font-display', display: 'swap', style: ['normal', 'italic'], axes: ['opsz'] });

export const metadata: Metadata = {
  title: { default: 'Thrift Market — secondhand fashion across Nigeria', template: '%s · Thrift Market' },
  description: 'Find distinctive secondhand fashion, understand its condition, and complete the purchase with a clear record.',
  applicationName: 'Thrift Market',
};

export const viewport: Viewport = {
  themeColor: '#F7F3EB',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-NG" className={`${ui.variable} ${display.variable}`}>
      <body className="min-h-screen antialiased">
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <SandboxBanner />
        <SiteHeader />
        <main id="main" className="min-h-[60vh]">
          {children}
        </main>
        <Footer />
        <MobileNav />
      </body>
    </html>
  );
}
