import { notFound } from 'next/navigation';
import { WorkspaceShell } from '@/components/layout/WorkspaceShell';
import { routes } from '@/lib/routes';
import { requireUserPage } from '@/server/session';

/** Staff-only console. Non-staff get a 404 (no hint that the console exists). Each page re-checks its own role. */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUserPage(routes.admin.home);
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
