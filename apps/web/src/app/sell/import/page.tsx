import { IMPORT_COLUMNS } from '@thrift/application';
import { CardSection } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { routes } from '@/lib/routes';
import { requireUserPage } from '@/server/session';
import { ImportForm } from './ImportForm';

export const metadata = { title: 'Import listings' };

/** Owned-content import: a seller’s own catalogue from a spreadsheet, as drafts that still need photos and checks. */
export default async function ImportListingsPage() {
  await requireUserPage(routes.sell.importListings);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Import listings"
        description="Bring your own catalogue in from a spreadsheet (saved as CSV). Each row becomes a draft — nothing goes live until you add real photos of the piece, confirm its flaws and publish it."
      />
      <CardSection title="1. Get the template">
        <p className="text-sm text-muted">
          Columns: {IMPORT_COLUMNS.join(', ')}. Only <strong>title</strong> and <strong>category</strong> are required; category is the category name or slug from the listing editor;
          prices are in naira; sale mode is fixed or negotiable (auctions are scheduled from a draft).
        </p>
        <a href="/sell/import/template.csv" className="mt-2 inline-block font-semibold text-primary underline" download>Download the CSV template</a>
      </CardSection>
      <CardSection title="2. Upload your file">
        <ImportForm />
      </CardSection>
      <p className="text-sm text-muted">Only import listings you own. Copying other people’s photos or listings is not allowed, and imported stock is not kept in sync with other sites.</p>
    </div>
  );
}
