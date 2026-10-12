-- 0500_messaging_offers_indexes.sql (slice E: messaging + offers)
-- Supporting indexes only; no schema changes to the core tables.

-- Duplicate-message spam heuristic and per-sender history scans.
CREATE INDEX messages_sender_recent_idx ON messages (sender_user_id, created_at DESC) WHERE sender_user_id IS NOT NULL;

-- Offer cards / thread state shown inside a conversation.
CREATE INDEX offer_threads_conversation_idx ON offer_threads (conversation_id) WHERE conversation_id IS NOT NULL;

-- Closing other negotiations on a listing when it sells; buyer's own offers list.
CREATE INDEX offer_threads_listing_status_idx ON offer_threads (listing_id, status);
CREATE INDEX offer_threads_buyer_idx ON offer_threads (buyer_user_id, updated_at DESC);

-- Linking order events to their conversation.
CREATE INDEX conversations_order_idx ON conversations (order_id) WHERE order_id IS NOT NULL;

-- Block checks in both directions.
CREATE INDEX user_blocks_blocked_idx ON user_blocks (blocked_user_id);
