import { redirect } from 'next/navigation';
import { routes } from '@/lib/routes';

/** The editorial cover lives at “/”; “/discover” is the catalogue (search with filters), kept as one canonical URL. */
export default async function DiscoverPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) if (typeof v === 'string') params[k] = v;
  redirect(routes.search(params));
}
