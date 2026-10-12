import { PageHeader } from '@/components/ui/PageHeader';

export const metadata = { title: 'How buying works' };

export default function HelpPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <PageHeader eyebrow="Help" title="How buying works" description="Plain answers about condition, payment, delivery and disputes." />
      <div className="space-y-8 text-[15px] leading-7">
        <section>
          <h2 className="text-xl font-semibold">Condition and photos</h2>
          <p className="mt-2 text-muted">
            Sellers choose one of four condition grades — unworn, excellent used, good used or visibly worn — and either confirm there are no known flaws or describe each flaw with a photo. What you buy is saved with your order exactly as it was described.
          </p>
        </section>
        <section>
          <h2 className="text-xl font-semibold">Fixed price, offers and auctions</h2>
          <p className="mt-2 text-muted">
            Each listing has one sale mode. Adding an item to your basket does not reserve it. Starting checkout or having an offer accepted holds the item for you for a short time. Auctions follow the rules shown on the auction page, including the end-time extension for late bids. A winning bid must be paid by the stated deadline.
          </p>
        </section>
        <section id="protection">
          <h2 className="text-xl font-semibold">Payment, delivery and disputes</h2>
          <p className="mt-2 text-muted">
            You pay through the platform checkout and every cost is itemised before you pay. Sellers are paid after delivery is confirmed by you or verified by the courier and no dispute is open. If something is wrong — not delivered, an undisclosed defect, the wrong item or transit damage — open a dispute from your order within the stated window.
          </p>
          <p className="mt-2 text-sm text-muted">
            The exact protection terms depend on the payment provider arrangement, which is still being finalised. Until then this environment runs in sandbox mode and no real money moves.
          </p>
        </section>
        <section>
          <h2 className="text-xl font-semibold">Verified sellers and reputation</h2>
          <p className="mt-2 text-muted">
            “Identity verified” means the seller completed specific identity checks on the date shown. It does not mean an item is authentic. Service reputation comes from completed orders, on-time dispatch, cancellations, upheld disputes and reviews from real buyers. Sponsored placements are always labelled and never affect verification or reputation.
          </p>
        </section>
      </div>
    </div>
  );
}
