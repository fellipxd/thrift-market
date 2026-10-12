export interface OutboundMessage {
  channel: 'email' | 'sms';
  destination: string;
  subject?: string | null;
  body: string;
}

export interface SendResult {
  status: 'sent' | 'failed';
  providerMessageId: string | null;
  error?: string;
}

/** Email/SMS delivery adapter. Marketing sends must already have passed consent checks. */
export interface MessageSender {
  readonly name: string;
  readonly isSandbox: boolean;
  send(message: OutboundMessage): Promise<SendResult>;
}

/** Records nothing externally; the outbound_messages row is the delivery record in development. */
export class SandboxMessageSender implements MessageSender {
  readonly name = 'sandbox';
  readonly isSandbox = true;
  async send(message: OutboundMessage): Promise<SendResult> {
    if (process.env.NODE_ENV !== 'test') {
      console.log(`[sandbox-${message.channel}] to=${message.destination} ${message.subject ?? ''} :: ${message.body.slice(0, 160)}`);
    }
    return { status: 'sent', providerMessageId: null };
  }
}
