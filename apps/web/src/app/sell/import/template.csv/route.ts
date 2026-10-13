import { IMPORT_TEMPLATE_CSV } from '@thrift/application';

/** CSV template for importing a seller's own listings as drafts. */
export function GET(): Response {
  return new Response(IMPORT_TEMPLATE_CSV, {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="thrift-listings-template.csv"' },
  });
}
