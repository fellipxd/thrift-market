import { paymentWebhookHandler } from '@/server/webhooks';

/** Inactive until Paystack is enabled (decision D04): the configured provider must be "paystack" or this returns 404. */
export const dynamic = 'force-dynamic';
export const POST = paymentWebhookHandler('paystack');
