import { paymentWebhookHandler } from '@/server/webhooks';

export const dynamic = 'force-dynamic';
export const POST = paymentWebhookHandler('sandbox');
