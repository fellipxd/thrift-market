import type { Metadata, Viewport } from 'next';
import { Inter, Source_Serif_4 } from 'next/font/google';
import { Footer } from '@/components/layout/Footer';
import { MobileNav } from '@/components/layout/MobileNav';
import { SandboxBanner } from '@/components/layout/SandboxBanner';
import { SiteHeader } from '@/components/layout/SiteHeader';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const serif = Source_Serif_4({ subsets: ['latin'], variable: '--font-serif-display', display: 'swap', weight: ['400', '600'], style: ['normal', 'italic'] });

export const metadata: Metadata = {
  title: { default: 'Thrift Market — secondhand fashion across Nigeria', template: '%s · Thrift Market' },
  description: 'Find distinctive secondhand fashion, understand its condition, and complete the purchase with a clear record.',
  applicationName: 'Thrift Market',
};

export const viewport: Viewport = {
  themeColor: '#174A3C',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-NG" className={`${inter.variable} ${serif.variable}`}>
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
