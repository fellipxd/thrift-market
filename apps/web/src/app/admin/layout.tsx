import { notFound } from 'next/navigation';
import { WorkspaceShell } from '@/components/layout/WorkspaceShell';
import { routes } from '@/lib/routes';
import { getUser } from '@/server/session';

/**
 * Staff-only console shell. Every page guards itself with requireStaffPage (layouts and pages render in
 * parallel), which sends signed-out or unconfirmed staff to sign-in / the two-step check with the path they asked for.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser();
  if (!user || !user.mfaVerified) return <>{children}</>;
  if (user.roles.length === 0) notFound();
  const items = [
    { href: routes.admin.home, label: 'Overview' },
    { href: routes.admin.verification, label: 'Seller verification' },
    { href: routes.admin.reports, label: 'Reports' },
    { href: routes.admin.disputes, label: 'Disputes' },
    { href: routes.admin.reviews, label: 'Review moderation' },
    { href: routes.admin.ads, label: 'Promotions' },
    { href: routes.admin.finance, label: 'Finance' },
    { href: routes.admin.categories, label: 'Categories' },
    { href: routes.admin.operations, label: 'Operations' },
    { href: routes.admin.audit, label: 'Audit log' },
    { href: routes.admin.settings, label: 'Policy settings' },
    { href: routes.admin.staff, label: 'Staff access' },
  ];
  return (
    <WorkspaceShell title="Operations" subtitle={`Signed in as ${user.displayName} · ${user.roles.join(', ')}`} items={items}>
      {children}
    </WorkspaceShell>
  );
}
