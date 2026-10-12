import { services } from '@/server/services';

/** Visible whenever payments or couriers are simulated, so mocks are never mistaken for real protection. */
export function SandboxBanner() {
  const { providers } = services();
  if (!providers.payments.isSandbox && !providers.courier.isSandbox) return null;
  return (
    <div className="bg-warning-soft px-4 py-1.5 text-center text-xs font-medium text-warning" role="note">
      Sandbox mode: payments and courier tracking are simulated. No real money moves and no parcels are collected.
    </div>
  );
}
