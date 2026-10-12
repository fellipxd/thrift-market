import Link from 'next/link';
import { routes } from '@/lib/routes';

export function Footer() {
  return (
    <footer className="mt-24 border-t border-ink pb-24 pt-12 md:pb-12">
      <div className="mx-auto grid max-w-[1280px] gap-10 px-4 text-sm text-muted md:grid-cols-12 md:px-8 xl:px-12">
        <div className="md:col-span-6">
          <p className="display text-4xl text-ink md:text-5xl">Fashion, found again.</p>
          <p className="mt-4 max-w-sm">A marketplace for secondhand fashion across Nigeria. &ldquo;Thrift Market&rdquo; is a working name.</p>
        </div>
        <div className="md:col-span-3">
          <p className="label-caps text-ink">Shop</p>
          <ul className="mt-3 space-y-2">
            <li><Link href={routes.search()} className="hover:text-ink hover:underline">Browse everything</Link></li>
            <li><Link href={routes.auctions} className="hover:text-ink hover:underline">Auctions</Link></li>
            <li><Link href={routes.nearby()} className="hover:text-ink hover:underline">Nearby shops</Link></li>
          </ul>
        </div>
        <div className="md:col-span-3">
          <p className="label-caps text-ink">Sell and support</p>
          <ul className="mt-3 space-y-2">
            <li><Link href={routes.sell.home} className="hover:text-ink hover:underline">Open a shop</Link></li>
            <li><Link href="/help" className="hover:text-ink hover:underline">How buying works</Link></li>
            <li><Link href="/help#protection" className="hover:text-ink hover:underline">Payments, delivery and disputes</Link></li>
          </ul>
        </div>
      </div>
    </footer>
  );
}
