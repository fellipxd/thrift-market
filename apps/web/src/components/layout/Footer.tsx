import Link from 'next/link';
import { routes } from '@/lib/routes';

export function Footer() {
  return (
    <footer className="mt-16 border-t border-line bg-surface pb-24 pt-10 md:pb-10">
      <div className="mx-auto grid max-w-7xl gap-8 px-4 text-sm text-muted sm:grid-cols-3">
        <div>
          <p className="font-serif text-lg text-primary">Good finds. Clearly described.</p>
          <p className="mt-2">A marketplace for secondhand fashion across Nigeria. &ldquo;Thrift Market&rdquo; is a working name.</p>
        </div>
        <div>
          <p className="font-semibold text-ink">Shop</p>
          <ul className="mt-2 space-y-1.5">
            <li><Link href={routes.search()} className="hover:text-primary">Browse everything</Link></li>
            <li><Link href={routes.auctions} className="hover:text-primary">Auctions</Link></li>
            <li><Link href={routes.nearby()} className="hover:text-primary">Nearby shops</Link></li>
          </ul>
        </div>
        <div>
          <p className="font-semibold text-ink">Sell and support</p>
          <ul className="mt-2 space-y-1.5">
            <li><Link href={routes.sell.home} className="hover:text-primary">Open a shop</Link></li>
            <li><Link href="/help" className="hover:text-primary">How buying works</Link></li>
            <li><Link href="/help#protection" className="hover:text-primary">Payments, delivery and disputes</Link></li>
          </ul>
        </div>
      </div>
    </footer>
  );
}
