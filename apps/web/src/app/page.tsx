import Link from 'next/link';
import { routes } from '@/lib/routes';

// Placeholder home; the discovery slice replaces this with the full feed.
export default function HomePage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-10">
      <h1 className="font-serif text-4xl text-primary sm:text-5xl">Good finds. Clearly described.</h1>
      <p className="mt-3 max-w-xl text-muted">Secondhand clothes, shoes, bags and accessories from sellers across Nigeria.</p>
      <div className="mt-6 flex gap-3">
        <Link href={routes.search()} className="font-semibold text-primary underline">Browse</Link>
        <Link href={routes.sell.home} className="font-semibold text-primary underline">Sell</Link>
      </div>
    </div>
  );
}
