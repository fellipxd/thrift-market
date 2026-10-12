-- 0001_core_schema.sql
-- Core commerce schema for the thrift marketplace (all domains).
-- Conventions:
--   * UUID primary keys (gen_random_uuid()).
--   * Money is BIGINT minor units (kobo) + currency char(3). Never floating point.
--   * Status columns are TEXT + CHECK constraints so state machines can evolve via migrations.
--   * timestamptz everywhere; the server stores UTC. Display converts to Africa/Lagos (WAT).
--   * PostgreSQL is the authority for stock, reservations, bids and money records.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS postgis;

-- ---------------------------------------------------------------------------
-- Platform configuration and policy versions
-- ---------------------------------------------------------------------------

CREATE TABLE platform_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  description text NOT NULL DEFAULT '',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid
);

CREATE TABLE policy_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind IN ('checkout_terms','buyer_protection','auction_rules','seller_terms','promotion_terms','privacy','returns')),
  version      text NOT NULL,
  title        text NOT NULL,
  body         text NOT NULL,
  effective_at timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, version)
);

-- Reference places used to geocode typed city/state searches (approximate centroids).
CREATE TABLE places (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  state      text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('state','city','area')),
  location   geography(Point, 4326) NOT NULL,
  population_rank int NOT NULL DEFAULT 100,
  UNIQUE (name, state, kind)
);
CREATE INDEX places_location_gix ON places USING gist (location);
CREATE INDEX places_name_trgm ON places USING gin (lower(name) gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name       text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  email              text,
  phone              text,
  password_hash      text NOT NULL,
  email_verified_at  timestamptz,
  phone_verified_at  timestamptz,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  suspended_reason   text,
  mfa_secret         text,
  failed_login_count int NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  auction_strikes    int NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX users_phone_uq ON users (phone) WHERE phone IS NOT NULL;

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  user_agent   text,
  ip           text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE contact_verifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel     text NOT NULL CHECK (channel IN ('email','phone')),
  destination text NOT NULL,
  code_hash   text NOT NULL,
  attempts    int NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contact_verifications_user_idx ON contact_verifications (user_id, created_at DESC);

CREATE TABLE role_grants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('support','trust_safety','finance','admin')),
  granted_by  uuid REFERENCES users(id),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  revoked_by  uuid REFERENCES users(id)
);
CREATE UNIQUE INDEX role_grants_active_uq ON role_grants (user_id, role) WHERE revoked_at IS NULL;

CREATE TABLE addresses (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label          text NOT NULL DEFAULT 'Home',
  recipient_name text NOT NULL,
  phone          text NOT NULL,
  line1          text NOT NULL,
  line2          text,
  area           text,
  city           text NOT NULL,
  state          text NOT NULL,
  landmark       text,
  is_default     boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  archived_at    timestamptz
);
CREATE INDEX addresses_user_idx ON addresses (user_id);

-- ---------------------------------------------------------------------------
-- Media (object storage metadata). Bytes live in object storage, never in Postgres.
-- ---------------------------------------------------------------------------

CREATE TABLE media_assets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  purpose       text NOT NULL CHECK (purpose IN ('listing','shop_logo','shop_banner','message','dispute_evidence','delivery_proof','verification_evidence','review')),
  storage_key   text NOT NULL UNIQUE,
  mime_type     text NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp')),
  bytes         int NOT NULL CHECK (bytes > 0),
  width         int,
  height        int,
  sha256        text NOT NULL,
  status        text NOT NULL DEFAULT 'ready' CHECK (status IN ('pending','ready','rejected','quarantined')),
  visibility    text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','restricted')),
  alt_text      text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_assets_owner_idx ON media_assets (owner_user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Shops and seller onboarding
-- ---------------------------------------------------------------------------

CREATE TABLE shops (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$'),
  name                text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 60),
  bio                 text NOT NULL DEFAULT '',
  owner_user_id       uuid NOT NULL UNIQUE REFERENCES users(id),
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','suspended')),
  status_reason       text,
  -- Public, approximate location only (neighbourhood/city level or seller-approved pickup point).
  city                text NOT NULL,
  state               text NOT NULL,
  area                text,
  location            geography(Point, 4326),
  location_precision  text NOT NULL DEFAULT 'city' CHECK (location_precision IN ('city','area','pickup_point')),
  pickup_note         text,
  logo_media_id       uuid REFERENCES media_assets(id),
  banner_media_id     uuid REFERENCES media_assets(id),
  returns_policy      text NOT NULL DEFAULT '',
  dispatch_days       int NOT NULL DEFAULT 2 CHECK (dispatch_days BETWEEN 0 AND 14),
  verification_status text NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified','pending','approved','rejected','reverification','suspended')),
  verified_at         timestamptz,
  verification_label  text,
  -- Denormalised reputation projection; written only by the reputation job.
  review_count        int NOT NULL DEFAULT 0,
  rating_avg          numeric(3,2),
  completed_orders    int NOT NULL DEFAULT 0,
  reputation_tier     text NOT NULL DEFAULT 'new' CHECK (reputation_tier IN ('new','established','trusted','under_review')),
  reputation_score    numeric(5,2),
  follower_count      int NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  published_at        timestamptz
);
CREATE INDEX shops_location_gix ON shops USING gist (location);
CREATE INDEX shops_state_city_idx ON shops (state, city) WHERE status = 'active';
CREATE INDEX shops_name_trgm ON shops USING gin (lower(name) gin_trgm_ops);

CREATE TABLE shop_members (
  shop_id    uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','staff')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, user_id)
);

-- Where a shop will send orders. One active coverage row per shop; listings may narrow it.
CREATE TABLE delivery_coverage (
  shop_id               uuid PRIMARY KEY REFERENCES shops(id) ON DELETE CASCADE,
  scope                 text NOT NULL DEFAULT 'local' CHECK (scope IN ('local','states','national')),
  states                text[] NOT NULL DEFAULT '{}',
  excluded_states       text[] NOT NULL DEFAULT '{}',
  offers_pickup         boolean NOT NULL DEFAULT false,
  offers_seller_arranged boolean NOT NULL DEFAULT true,
  offers_integrated     boolean NOT NULL DEFAULT false,
  -- Seller-arranged delivery fees (minor units) by zone.
  same_city_fee_minor   bigint NOT NULL DEFAULT 150000 CHECK (same_city_fee_minor >= 0),
  same_state_fee_minor  bigint NOT NULL DEFAULT 250000 CHECK (same_state_fee_minor >= 0),
  interstate_fee_minor  bigint NOT NULL DEFAULT 450000 CHECK (interstate_fee_minor >= 0),
  transit_days_min      int NOT NULL DEFAULT 1 CHECK (transit_days_min >= 0),
  transit_days_max      int NOT NULL DEFAULT 5 CHECK (transit_days_max >= transit_days_min),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE verification_cases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id         uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  kind            text NOT NULL DEFAULT 'identity' CHECK (kind IN ('identity','business','reverification')),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','withdrawn')),
  -- Restricted evidence: references to restricted media and typed fields; access is audited.
  legal_name      text NOT NULL,
  id_type         text CHECK (id_type IN ('nin','drivers_licence','passport','voters_card','cac_registration')),
  id_number_last4 text,
  evidence_media_ids uuid[] NOT NULL DEFAULT '{}',
  submitted_by    uuid NOT NULL REFERENCES users(id),
  submitted_at    timestamptz NOT NULL DEFAULT now(),
  decided_by      uuid REFERENCES users(id),
  decided_at      timestamptz,
  decision_reason text,
  CHECK ((status IN ('approved','rejected')) = (decided_at IS NOT NULL AND decision_reason IS NOT NULL))
);
CREATE INDEX verification_cases_status_idx ON verification_cases (status, submitted_at);
CREATE UNIQUE INDEX verification_cases_one_pending ON verification_cases (shop_id) WHERE status = 'pending';

CREATE TABLE payout_accounts (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id                 uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  bank_code               text NOT NULL,
  bank_name               text NOT NULL,
  account_number_last4    text NOT NULL CHECK (account_number_last4 ~ '^[0-9]{4}$'),
  account_name            text NOT NULL,
  provider_recipient_code text,
  status                  text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected','replaced')),
  name_match              boolean,
  created_by              uuid NOT NULL REFERENCES users(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  -- A changed beneficiary cannot receive payouts until this cooling-off time passes.
  usable_after            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payout_accounts_one_active ON payout_accounts (shop_id) WHERE status IN ('pending','verified');

-- ---------------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------------

CREATE TABLE categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id  uuid REFERENCES categories(id),
  slug       text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]+$'),
  name       text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('clothes','shoes','bags','accessories')),
  sort_order int NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true,
  -- Restricted categories (e.g. intimate wear) require extra policy acceptance (decision D11).
  restricted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX categories_parent_idx ON categories (parent_id);

-- Versioned attribute schema for a category. Listings record the version they were created with,
-- so old listings remain readable after a schema change.
CREATE TABLE attribute_schema_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES categories(id),
  version     int NOT NULL CHECK (version > 0),
  schema      jsonb NOT NULL,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (category_id, version)
);

CREATE TABLE batches (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id    uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name       text NOT NULL,
  note       text NOT NULL DEFAULT '',
  -- Optional scheduled public drop time; followers are notified once (deduplicated).
  drop_at    timestamptz,
  drop_announced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX batches_shop_idx ON batches (shop_id, created_at DESC);

CREATE TABLE listings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           uuid NOT NULL REFERENCES shops(id),
  category_id       uuid NOT NULL REFERENCES categories(id),
  schema_version_id uuid NOT NULL REFERENCES attribute_schema_versions(id),
  batch_id          uuid REFERENCES batches(id) ON DELETE SET NULL,
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','active','reserved','sold','paused','ended','removed')),
  sale_mode         text NOT NULL DEFAULT 'fixed' CHECK (sale_mode IN ('fixed','negotiable','auction')),
  title             text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 90),
  description       text NOT NULL DEFAULT '',
  brand             text,
  colour            text,
  material          text,
  size_system       text CHECK (size_system IN ('uk','us','eu','ng','intl_letter','waist_inches','one_size','other')),
  size_label        text,
  measurements      jsonb NOT NULL DEFAULT '{}'::jsonb,
  attributes        jsonb NOT NULL DEFAULT '{}'::jsonb,
  condition         text CHECK (condition IN ('unworn','excellent','good','worn')),
  -- Seller must affirm either no known flaws, or describe each flaw (with photo evidence).
  flaws_declaration text CHECK (flaws_declaration IN ('none_known','described')),
  flaws_affirmed_at timestamptz,
  quantity_mode     text NOT NULL DEFAULT 'unique' CHECK (quantity_mode IN ('unique','equivalent')),
  price_minor       bigint CHECK (price_minor IS NULL OR price_minor > 0),
  currency          char(3) NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  -- Private negotiation floor. Never exposed by public APIs.
  min_offer_minor   bigint CHECK (min_offer_minor IS NULL OR min_offer_minor > 0),
  -- Optional per-listing narrowing of shop delivery coverage.
  delivery_states   text[],
  weight_grams      int CHECK (weight_grams IS NULL OR weight_grams > 0),
  version           int NOT NULL DEFAULT 1,
  published_at      timestamptz,
  sold_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  search_vector     tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(brand, '') || ' ' || coalesce(colour, '') || ' ' || coalesce(material, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(description, '')), 'C')
  ) STORED,
  CHECK (min_offer_minor IS NULL OR price_minor IS NULL OR min_offer_minor <= price_minor),
  CHECK (sale_mode <> 'auction' OR quantity_mode = 'unique')
);
CREATE INDEX listings_shop_idx ON listings (shop_id, status, created_at DESC);
CREATE INDEX listings_browse_idx ON listings (status, published_at DESC, id) WHERE status IN ('active','reserved');
CREATE INDEX listings_category_idx ON listings (category_id, status);
CREATE INDEX listings_price_idx ON listings (price_minor) WHERE status = 'active';
CREATE INDEX listings_search_gin ON listings USING gin (search_vector);
CREATE INDEX listings_title_trgm ON listings USING gin (lower(title) gin_trgm_ops);
CREATE INDEX listings_batch_idx ON listings (batch_id);

-- Immutable published versions of a listing (what a buyer saw at a given time).
CREATE TABLE listing_versions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  version    int NOT NULL,
  snapshot   jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (listing_id, version)
);

CREATE TABLE listing_media (
  listing_id uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  media_id   uuid NOT NULL REFERENCES media_assets(id),
  position   int NOT NULL CHECK (position >= 0),
  caption    text,
  role       text NOT NULL DEFAULT 'general' CHECK (role IN ('front','back','label','detail','sole','lining','closure','flaw','general')),
  PRIMARY KEY (listing_id, media_id),
  UNIQUE (listing_id, position)
);

CREATE TABLE listing_flaws (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id  uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  description text NOT NULL CHECK (char_length(description) BETWEEN 3 AND 300),
  location    text,
  severity    text NOT NULL DEFAULT 'minor' CHECK (severity IN ('minor','moderate','major')),
  media_id    uuid REFERENCES media_assets(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX listing_flaws_listing_idx ON listing_flaws (listing_id);

-- Reusable listing templates (social-transition tooling).
CREATE TABLE listing_templates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id    uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name       text NOT NULL,
  data       jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Inventory authority: one stock row per listing. All allocation paths
-- (checkout, accepted offer, auction win) lock this row FOR UPDATE.
-- ---------------------------------------------------------------------------

CREATE TABLE inventory_stock (
  listing_id         uuid PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
  quantity_total     int NOT NULL CHECK (quantity_total >= 0),
  quantity_available int NOT NULL CHECK (quantity_available >= 0),
  quantity_reserved  int NOT NULL DEFAULT 0 CHECK (quantity_reserved >= 0),
  quantity_sold      int NOT NULL DEFAULT 0 CHECK (quantity_sold >= 0),
  quantity_withdrawn int NOT NULL DEFAULT 0 CHECK (quantity_withdrawn >= 0),
  version            int NOT NULL DEFAULT 1,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (quantity_total = quantity_available + quantity_reserved + quantity_sold + quantity_withdrawn)
);

CREATE TABLE inventory_movements (
  id          bigserial PRIMARY KEY,
  listing_id  uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('stock_in','reserve','release','sell','withdraw','restock','adjust')),
  quantity    int NOT NULL,
  reason      text,
  reservation_id uuid,
  actor_user_id uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_movements_listing_idx ON inventory_movements (listing_id, id);

CREATE TABLE reservations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id      uuid NOT NULL REFERENCES listings(id),
  buyer_user_id   uuid NOT NULL REFERENCES users(id),
  quantity        int NOT NULL CHECK (quantity > 0),
  source          text NOT NULL CHECK (source IN ('checkout','offer','auction','second_chance')),
  source_id       uuid,
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor > 0),
  currency        char(3) NOT NULL DEFAULT 'NGN',
  -- active: hold valid until expires_at
  -- payment_pending: hold expired while a payment attempt is unresolved; must be reconciled, not freed by timer
  -- converted: stock sold to a paid order; released/expired: stock returned
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','payment_pending','converted','released','expired')),
  expires_at      timestamptz NOT NULL,
  grace_until     timestamptz,
  release_reason  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz
);
CREATE INDEX reservations_listing_idx ON reservations (listing_id, status);
CREATE INDEX reservations_buyer_idx ON reservations (buyer_user_id, status);
CREATE INDEX reservations_due_idx ON reservations (expires_at) WHERE status IN ('active','payment_pending');
CREATE UNIQUE INDEX reservations_source_uq ON reservations (source, source_id) WHERE source_id IS NOT NULL AND status IN ('active','payment_pending','converted');

-- ---------------------------------------------------------------------------
-- Messaging
-- ---------------------------------------------------------------------------

CREATE TABLE conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id         uuid NOT NULL REFERENCES shops(id),
  buyer_user_id   uuid NOT NULL REFERENCES users(id),
  listing_id      uuid REFERENCES listings(id),
  order_id        uuid,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','blocked')),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX conversations_listing_buyer_uq ON conversations (listing_id, buyer_user_id) WHERE listing_id IS NOT NULL;
CREATE INDEX conversations_buyer_idx ON conversations (buyer_user_id, last_message_at DESC);
CREATE INDEX conversations_shop_idx ON conversations (shop_id, last_message_at DESC);

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_user_id  uuid REFERENCES users(id),
  kind            text NOT NULL DEFAULT 'text' CHECK (kind IN ('text','image','offer','system')),
  body            text NOT NULL DEFAULT '' CHECK (char_length(body) <= 2000),
  media_id        uuid REFERENCES media_assets(id),
  offer_id        uuid,
  hidden_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at);

CREATE TABLE conversation_reads (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE user_blocks (
  blocker_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_user_id, blocked_user_id),
  CHECK (blocker_user_id <> blocked_user_id)
);

-- ---------------------------------------------------------------------------
-- Offers (bargaining)
-- ---------------------------------------------------------------------------

CREATE TABLE offer_threads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id      uuid NOT NULL REFERENCES listings(id),
  shop_id         uuid NOT NULL REFERENCES shops(id),
  buyer_user_id   uuid NOT NULL REFERENCES users(id),
  conversation_id uuid REFERENCES conversations(id),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','rejected','withdrawn','expired','closed_unavailable','completed')),
  agreed_price_minor bigint,
  reservation_id  uuid REFERENCES reservations(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX offer_threads_open_uq ON offer_threads (listing_id, buyer_user_id) WHERE status IN ('open','accepted');
CREATE INDEX offer_threads_shop_idx ON offer_threads (shop_id, status, updated_at DESC);

CREATE TABLE offers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id    uuid NOT NULL REFERENCES offer_threads(id) ON DELETE CASCADE,
  seq          int NOT NULL,
  from_party   text NOT NULL CHECK (from_party IN ('buyer','seller')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency     char(3) NOT NULL DEFAULT 'NGN',
  note         text CHECK (note IS NULL OR char_length(note) <= 280),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','countered','accepted','rejected','withdrawn','expired','auto_declined')),
  expires_at   timestamptz NOT NULL,
  responded_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (thread_id, seq)
);
CREATE UNIQUE INDEX offers_one_pending_uq ON offers (thread_id) WHERE status = 'pending';
CREATE INDEX offers_expiry_idx ON offers (expires_at) WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- Auctions
-- ---------------------------------------------------------------------------

CREATE TABLE auctions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id               uuid NOT NULL UNIQUE REFERENCES listings(id),
  shop_id                  uuid NOT NULL REFERENCES shops(id),
  status                   text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('draft','scheduled','live','ended_no_bids','awaiting_payment','paid','failed_unpaid','cancelled')),
  starts_at                timestamptz NOT NULL,
  ends_at                  timestamptz NOT NULL,
  original_ends_at         timestamptz NOT NULL,
  opening_price_minor      bigint NOT NULL CHECK (opening_price_minor > 0),
  increment_minor          bigint NOT NULL CHECK (increment_minor > 0),
  currency                 char(3) NOT NULL DEFAULT 'NGN',
  extension_window_seconds int NOT NULL DEFAULT 120,
  extension_seconds        int NOT NULL DEFAULT 120,
  max_extension_seconds    int NOT NULL DEFAULT 600,
  current_bid_minor        bigint,
  current_bid_id           uuid,
  current_bidder_user_id   uuid REFERENCES users(id),
  bid_count                int NOT NULL DEFAULT 0,
  seq                      int NOT NULL DEFAULT 0,
  winner_user_id           uuid REFERENCES users(id),
  winning_bid_id           uuid,
  payment_deadline_at      timestamptz,
  reservation_id           uuid REFERENCES reservations(id),
  policy_version_id        uuid REFERENCES policy_versions(id),
  finalized_at             timestamptz,
  cancelled_reason         text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (original_ends_at > starts_at)
);
CREATE INDEX auctions_due_idx ON auctions (ends_at) WHERE status = 'live';
CREATE INDEX auctions_start_idx ON auctions (starts_at) WHERE status = 'scheduled';
CREATE INDEX auctions_payment_due_idx ON auctions (payment_deadline_at) WHERE status = 'awaiting_payment';

CREATE TABLE bids (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id    uuid NOT NULL REFERENCES auctions(id),
  bidder_user_id uuid NOT NULL REFERENCES users(id),
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  seq           int NOT NULL,
  idempotency_key text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (auction_id, seq),
  UNIQUE (auction_id, bidder_user_id, idempotency_key)
);
CREATE INDEX bids_auction_amount_idx ON bids (auction_id, amount_minor DESC, seq);

CREATE TABLE auction_events (
  id         bigserial PRIMARY KEY,
  auction_id uuid NOT NULL REFERENCES auctions(id),
  seq        int NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('scheduled','started','bid','extended','ended','winner_allocated','payment_received','failed_unpaid','second_chance_offered','cancelled','relisted')),
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auction_events_auction_idx ON auction_events (auction_id, id);

CREATE TABLE second_chance_offers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id    uuid NOT NULL REFERENCES auctions(id),
  bidder_user_id uuid NOT NULL REFERENCES users(id),
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','expired')),
  expires_at    timestamptz NOT NULL,
  reservation_id uuid REFERENCES reservations(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  responded_at  timestamptz
);
CREATE UNIQUE INDEX second_chance_one_pending ON second_chance_offers (auction_id) WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- Orders: immutable purchase snapshots + separate state machines.
-- ---------------------------------------------------------------------------

CREATE SEQUENCE order_number_seq START 100001;

CREATE TABLE orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number              text NOT NULL UNIQUE DEFAULT ('TM' || nextval('order_number_seq')::text),
  buyer_user_id       uuid NOT NULL REFERENCES users(id),
  shop_id             uuid NOT NULL REFERENCES shops(id),
  source              text NOT NULL CHECK (source IN ('checkout','offer','auction','second_chance')),
  source_id           uuid,
  reservation_id      uuid REFERENCES reservations(id),
  -- Order lifecycle (commercial), separate from payment / fulfilment / payout states.
  status              text NOT NULL DEFAULT 'pending_payment' CHECK (status IN ('pending_payment','confirmed','completed','cancelled')),
  payment_status      text NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending','paid','failed','refund_pending','partially_refunded','refunded')),
  fulfilment_status   text NOT NULL DEFAULT 'unfulfilled' CHECK (fulfilment_status IN ('unfulfilled','awaiting_dispatch','dispatched','in_transit','delivered','delivery_exception','returned','cancelled')),
  payout_status       text NOT NULL DEFAULT 'not_applicable' CHECK (payout_status IN ('not_applicable','held','eligible','released','blocked','reversed')),
  dispute_status      text NOT NULL DEFAULT 'none' CHECK (dispute_status IN ('none','open','resolved')),
  currency            char(3) NOT NULL DEFAULT 'NGN',
  items_total_minor   bigint NOT NULL CHECK (items_total_minor > 0),
  shipping_minor      bigint NOT NULL DEFAULT 0 CHECK (shipping_minor >= 0),
  buyer_fee_minor     bigint NOT NULL DEFAULT 0 CHECK (buyer_fee_minor >= 0),
  total_minor         bigint NOT NULL CHECK (total_minor > 0),
  commission_minor    bigint NOT NULL DEFAULT 0 CHECK (commission_minor >= 0),
  delivery_method     text NOT NULL CHECK (delivery_method IN ('integrated','seller_arranged','pickup')),
  shipping_address    jsonb,
  delivery_terms      jsonb NOT NULL DEFAULT '{}'::jsonb,
  policy_versions     jsonb NOT NULL DEFAULT '{}'::jsonb,
  cancel_reason       text,
  idempotency_key     text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  paid_at             timestamptz,
  dispatched_at       timestamptz,
  delivered_at        timestamptz,
  buyer_confirmed_at  timestamptz,
  completed_at        timestamptz,
  cancelled_at        timestamptz,
  CHECK (total_minor = items_total_minor + shipping_minor + buyer_fee_minor),
  UNIQUE (buyer_user_id, idempotency_key)
);
CREATE INDEX orders_buyer_idx ON orders (buyer_user_id, created_at DESC);
CREATE INDEX orders_shop_idx ON orders (shop_id, created_at DESC);
CREATE INDEX orders_status_idx ON orders (status, payment_status);
CREATE UNIQUE INDEX orders_reservation_live_uq ON orders (reservation_id) WHERE reservation_id IS NOT NULL AND status <> 'cancelled';

CREATE TABLE order_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  listing_id         uuid NOT NULL REFERENCES listings(id),
  listing_version_id uuid REFERENCES listing_versions(id),
  quantity           int NOT NULL CHECK (quantity > 0),
  unit_price_minor   bigint NOT NULL CHECK (unit_price_minor > 0),
  -- Immutable snapshot: title, condition, flaws, media keys, measurements, size, seller, policy version.
  snapshot           jsonb NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_items_order_idx ON order_items (order_id);
CREATE INDEX order_items_listing_idx ON order_items (listing_id);

CREATE TABLE order_events (
  id          bigserial PRIMARY KEY,
  order_id    uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  actor_kind  text NOT NULL CHECK (actor_kind IN ('buyer','seller','staff','system','provider')),
  actor_user_id uuid,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_events_order_idx ON order_events (order_id, id);

ALTER TABLE conversations ADD CONSTRAINT conversations_order_fk FOREIGN KEY (order_id) REFERENCES orders(id);

-- ---------------------------------------------------------------------------
-- Payments, ledger, refunds, payouts
-- ---------------------------------------------------------------------------

CREATE TABLE payment_attempts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose          text NOT NULL DEFAULT 'order' CHECK (purpose IN ('order','ad_campaign')),
  order_id         uuid REFERENCES orders(id),
  ad_campaign_id   uuid,
  payer_user_id    uuid NOT NULL REFERENCES users(id),
  provider         text NOT NULL CHECK (provider IN ('sandbox','paystack')),
  reference        text NOT NULL UNIQUE,
  amount_minor     bigint NOT NULL CHECK (amount_minor > 0),
  currency         char(3) NOT NULL DEFAULT 'NGN',
  -- initiated: recorded before provider call; pending: provider accepted; uncertain: provider call outcome unknown.
  status           text NOT NULL DEFAULT 'initiated' CHECK (status IN ('initiated','pending','uncertain','succeeded','failed','abandoned')),
  authorization_url text,
  provider_transaction_id text,
  failure_reason   text,
  last_verified_at timestamptz,
  succeeded_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((purpose = 'order') = (order_id IS NOT NULL))
);
CREATE INDEX payment_attempts_order_idx ON payment_attempts (order_id);
CREATE INDEX payment_attempts_unresolved_idx ON payment_attempts (created_at) WHERE status IN ('initiated','pending','uncertain');
CREATE UNIQUE INDEX payment_attempts_one_success_per_order ON payment_attempts (order_id) WHERE status = 'succeeded' AND order_id IS NOT NULL;

-- Durable inbox for provider webhooks. Acknowledge only after this insert commits.
CREATE TABLE webhook_inbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider        text NOT NULL,
  dedupe_key      text NOT NULL,
  event_type      text NOT NULL,
  payload         jsonb NOT NULL,
  signature_valid boolean NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processed','failed','ignored')),
  attempts        int NOT NULL DEFAULT 0,
  last_error      text,
  received_at     timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz,
  UNIQUE (provider, dedupe_key)
);
CREATE INDEX webhook_inbox_pending_idx ON webhook_inbox (next_attempt_at) WHERE status = 'pending';

-- Append-only, balanced double-entry ledger of obligations and provider movements.
-- It is not a wallet and does not prove provider-held funds; reconcile with provider statements.
CREATE TABLE ledger_transactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('payment_captured','refund_issued','payout_released','payout_reversed','ad_payment','adjustment','late_payment_refund')),
  order_id        uuid REFERENCES orders(id),
  description     text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id             bigserial PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES ledger_transactions(id),
  account        text NOT NULL CHECK (account IN ('provider_clearing','seller_payable','platform_commission','platform_fees','courier_payable','refunds_payable','ad_revenue','suspense')),
  shop_id        uuid REFERENCES shops(id),
  -- Positive = debit, negative = credit. Each transaction sums to zero.
  amount_minor   bigint NOT NULL CHECK (amount_minor <> 0),
  currency       char(3) NOT NULL DEFAULT 'NGN',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_tx_idx ON ledger_entries (transaction_id);
CREATE INDEX ledger_entries_account_idx ON ledger_entries (account, shop_id);

CREATE OR REPLACE FUNCTION ledger_check_balanced() RETURNS trigger AS $$
DECLARE
  total bigint;
BEGIN
  SELECT coalesce(sum(amount_minor), 0) INTO total FROM ledger_entries WHERE transaction_id = NEW.transaction_id;
  IF total <> 0 THEN
    RAISE EXCEPTION 'ledger transaction % is unbalanced (sum=%)', NEW.transaction_id, total;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced();

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_transactions_append_only BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE refunds (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL REFERENCES orders(id),
  payment_attempt_id uuid NOT NULL REFERENCES payment_attempts(id),
  amount_minor       bigint NOT NULL CHECK (amount_minor > 0),
  currency           char(3) NOT NULL DEFAULT 'NGN',
  reason             text NOT NULL CHECK (reason IN ('buyer_cancelled','seller_cancelled','dispute_upheld','late_payment_after_release','duplicate_payment','not_delivered','staff_exception')),
  note               text,
  -- requested -> approved -> processing -> succeeded | failed. Not complete until provider confirms.
  status             text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','processing','succeeded','failed','rejected')),
  provider_reference text,
  requested_by       uuid,
  approved_by        uuid,
  idempotency_key    text NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  confirmed_at       timestamptz,
  CHECK (approved_by IS NULL OR requested_by IS NULL OR approved_by <> requested_by OR reason <> 'staff_exception')
);
CREATE INDEX refunds_order_idx ON refunds (order_id);
CREATE INDEX refunds_status_idx ON refunds (status, created_at);

CREATE TABLE payouts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id            uuid NOT NULL REFERENCES shops(id),
  order_id           uuid NOT NULL UNIQUE REFERENCES orders(id),
  amount_minor       bigint NOT NULL CHECK (amount_minor >= 0),
  currency           char(3) NOT NULL DEFAULT 'NGN',
  -- held -> eligible -> processing -> paid | failed ; blocked by dispute ; reversed by finance
  status             text NOT NULL DEFAULT 'held' CHECK (status IN ('held','eligible','processing','paid','failed','blocked','reversed','cancelled')),
  hold_reason        text,
  eligible_at        timestamptz,
  payout_account_id  uuid REFERENCES payout_accounts(id),
  provider_reference text,
  released_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payouts_shop_idx ON payouts (shop_id, status);
CREATE INDEX payouts_eligible_idx ON payouts (eligible_at) WHERE status = 'eligible';

-- ---------------------------------------------------------------------------
-- Delivery
-- ---------------------------------------------------------------------------

CREATE TABLE shipments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            uuid NOT NULL UNIQUE REFERENCES orders(id),
  method              text NOT NULL CHECK (method IN ('integrated','seller_arranged','pickup')),
  provider            text,
  carrier_name        text,
  tracking_reference  text,
  tracking_url        text,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','booked','picked_up','in_transit','out_for_delivery','delivered','exception','returned','cancelled')),
  -- How we know the latest status: seller reported, courier verified, or buyer confirmed.
  confidence          text NOT NULL DEFAULT 'seller_reported' CHECK (confidence IN ('none','seller_reported','courier_verified','buyer_confirmed','staff_verified')),
  quote_minor         bigint CHECK (quote_minor IS NULL OR quote_minor >= 0),
  dispatch_by         timestamptz,
  transit_days_min    int,
  transit_days_max    int,
  proof_media_id      uuid REFERENCES media_assets(id),
  last_event_at       timestamptz,
  delivered_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shipment_events (
  id           bigserial PRIMARY KEY,
  shipment_id  uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  source       text NOT NULL CHECK (source IN ('courier','seller','buyer','staff','system')),
  status       text NOT NULL,
  description  text NOT NULL DEFAULT '',
  external_id  text,
  occurred_at  timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  data         jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (shipment_id, external_id)
);
CREATE INDEX shipment_events_shipment_idx ON shipment_events (shipment_id, occurred_at);

-- Courier route availability (from adapter/contract); checkout intersects this with shop coverage.
CREATE TABLE courier_routes (
  provider        text NOT NULL,
  origin_state    text NOT NULL,
  destination_state text NOT NULL,
  active          boolean NOT NULL DEFAULT true,
  base_fee_minor  bigint NOT NULL CHECK (base_fee_minor >= 0),
  transit_days_min int NOT NULL,
  transit_days_max int NOT NULL,
  PRIMARY KEY (provider, origin_state, destination_state)
);

-- ---------------------------------------------------------------------------
-- Disputes and returns
-- ---------------------------------------------------------------------------

CREATE TABLE disputes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL REFERENCES orders(id),
  opened_by       uuid NOT NULL REFERENCES users(id),
  reason          text NOT NULL CHECK (reason IN ('not_delivered','undisclosed_defect','wrong_item','transit_damage','other')),
  description     text NOT NULL CHECK (char_length(description) BETWEEN 10 AND 2000),
  status          text NOT NULL DEFAULT 'awaiting_seller' CHECK (status IN ('awaiting_seller','awaiting_buyer','under_review','resolved','withdrawn','appealed')),
  outcome         text CHECK (outcome IN ('full_refund','partial_refund','return_and_refund','no_refund','withdrawn')),
  refund_amount_minor bigint CHECK (refund_amount_minor IS NULL OR refund_amount_minor >= 0),
  resolution_note text,
  decided_by      uuid REFERENCES users(id),
  assigned_to     uuid REFERENCES users(id),
  respond_by      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz,
  appeal_reason   text,
  appealed_at     timestamptz
);
CREATE UNIQUE INDEX disputes_one_active_per_order ON disputes (order_id) WHERE status IN ('awaiting_seller','awaiting_buyer','under_review','appealed');
CREATE INDEX disputes_status_idx ON disputes (status, created_at);

CREATE TABLE dispute_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id    uuid NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  author_user_id uuid REFERENCES users(id),
  author_role   text NOT NULL CHECK (author_role IN ('buyer','seller','staff','system')),
  body          text NOT NULL CHECK (char_length(body) <= 2000),
  media_ids     uuid[] NOT NULL DEFAULT '{}',
  internal      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dispute_entries_dispute_idx ON dispute_entries (dispute_id, created_at);

-- ---------------------------------------------------------------------------
-- Trust: reviews, reputation, reports, moderation
-- ---------------------------------------------------------------------------

CREATE TABLE reviews (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_item_id        uuid NOT NULL UNIQUE REFERENCES order_items(id),
  order_id             uuid NOT NULL REFERENCES orders(id),
  shop_id              uuid NOT NULL REFERENCES shops(id),
  author_user_id       uuid NOT NULL REFERENCES users(id),
  rating_overall       smallint NOT NULL CHECK (rating_overall BETWEEN 1 AND 5),
  rating_accuracy      smallint NOT NULL CHECK (rating_accuracy BETWEEN 1 AND 5),
  rating_communication smallint NOT NULL CHECK (rating_communication BETWEEN 1 AND 5),
  rating_delivery      smallint NOT NULL CHECK (rating_delivery BETWEEN 1 AND 5),
  body                 text NOT NULL DEFAULT '' CHECK (char_length(body) <= 1500),
  status               text NOT NULL DEFAULT 'published' CHECK (status IN ('published','hidden','removed')),
  seller_reply         text CHECK (seller_reply IS NULL OR char_length(seller_reply) <= 1000),
  seller_replied_at    timestamptz,
  moderated_by         uuid REFERENCES users(id),
  moderation_reason    text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reviews_shop_idx ON reviews (shop_id, created_at DESC) WHERE status = 'published';

CREATE TABLE reputation_snapshots (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id                uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  computed_at            timestamptz NOT NULL DEFAULT now(),
  completed_orders       int NOT NULL,
  review_count           int NOT NULL,
  rating_avg             numeric(3,2),
  on_time_dispatch_rate  numeric(5,4),
  seller_cancellations   int NOT NULL,
  upheld_disputes        int NOT NULL,
  score                  numeric(5,2),
  tier                   text NOT NULL,
  inputs                 jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX reputation_snapshots_shop_idx ON reputation_snapshots (shop_id, computed_at DESC);

CREATE TABLE reports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_user_id uuid NOT NULL REFERENCES users(id),
  target_kind     text NOT NULL CHECK (target_kind IN ('listing','shop','user','message','review')),
  target_id       uuid NOT NULL,
  reason          text NOT NULL CHECK (reason IN ('counterfeit','stolen','prohibited','misleading','harassment','spam','fraud','other')),
  details         text NOT NULL DEFAULT '' CHECK (char_length(details) <= 2000),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','actioned','dismissed')),
  handled_by      uuid REFERENCES users(id),
  handled_at      timestamptz,
  resolution_note text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reports_status_idx ON reports (status, created_at);
CREATE UNIQUE INDEX reports_dedupe_open ON reports (reporter_user_id, target_kind, target_id) WHERE status = 'open';

CREATE TABLE moderation_actions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  target_kind   text NOT NULL,
  target_id     uuid NOT NULL,
  action        text NOT NULL,
  reason        text NOT NULL CHECK (char_length(reason) >= 3),
  report_id     uuid REFERENCES reports(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX moderation_actions_target_idx ON moderation_actions (target_kind, target_id);

-- ---------------------------------------------------------------------------
-- Growth: follows, saves, notification consent, notifications, ads
-- ---------------------------------------------------------------------------

CREATE TABLE follows (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shop_id    uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  notify_drops boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, shop_id)
);
CREATE INDEX follows_shop_idx ON follows (shop_id);

CREATE TABLE saved_items (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, listing_id)
);
CREATE INDEX saved_items_listing_idx ON saved_items (listing_id);

-- Channel-specific consent per topic. Marketing topics require explicit opt-in.
CREATE TABLE notification_preferences (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic       text NOT NULL CHECK (topic IN ('transactional','messages','new_drops','auctions','promotions','digest')),
  channel     text NOT NULL CHECK (channel IN ('in_app','email','sms')),
  opted_in    boolean NOT NULL,
  consented_at timestamptz,
  source      text NOT NULL DEFAULT 'settings',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, topic, channel)
);

CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic      text NOT NULL,
  kind       text NOT NULL,
  title      text NOT NULL,
  body       text NOT NULL DEFAULT '',
  link       text,
  dedupe_key text NOT NULL,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

-- Outbound messages to external channels (email/SMS). Dev uses a sandbox sender.
CREATE TABLE outbound_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  channel     text NOT NULL CHECK (channel IN ('email','sms')),
  destination text NOT NULL,
  subject     text,
  body        text NOT NULL,
  kind        text NOT NULL,
  dedupe_key  text NOT NULL UNIQUE,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','suppressed')),
  provider    text,
  attempts    int NOT NULL DEFAULT 0,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);
CREATE INDEX outbound_messages_pending_idx ON outbound_messages (created_at) WHERE status = 'pending';

CREATE TABLE ad_packages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,
  name          text NOT NULL,
  target_kind   text NOT NULL CHECK (target_kind IN ('listing','shop')),
  placement     text NOT NULL CHECK (placement IN ('home_feed','search_results','nearby')),
  duration_days int NOT NULL CHECK (duration_days > 0),
  price_minor   bigint NOT NULL CHECK (price_minor > 0),
  currency      char(3) NOT NULL DEFAULT 'NGN',
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ad_campaigns (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id          uuid NOT NULL REFERENCES shops(id),
  package_id       uuid NOT NULL REFERENCES ad_packages(id),
  target_kind      text NOT NULL CHECK (target_kind IN ('listing','shop')),
  listing_id       uuid REFERENCES listings(id),
  placement        text NOT NULL,
  -- awaiting_payment -> pending_review -> scheduled/active -> ended ; rejected/cancelled refund per policy
  status           text NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN ('awaiting_payment','pending_review','scheduled','active','paused','ended','rejected','cancelled')),
  price_minor      bigint NOT NULL CHECK (price_minor > 0),
  currency         char(3) NOT NULL DEFAULT 'NGN',
  starts_at        timestamptz,
  ends_at          timestamptz,
  paid_at          timestamptz,
  reviewed_by      uuid REFERENCES users(id),
  review_reason    text,
  end_reason       text,
  refund_minor     bigint NOT NULL DEFAULT 0 CHECK (refund_minor >= 0),
  impressions      int NOT NULL DEFAULT 0,
  clicks           int NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((target_kind = 'listing') = (listing_id IS NOT NULL))
);
CREATE INDEX ad_campaigns_active_idx ON ad_campaigns (placement, status, ends_at);
CREATE INDEX ad_campaigns_shop_idx ON ad_campaigns (shop_id, created_at DESC);

ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempts_ad_fk FOREIGN KEY (ad_campaign_id) REFERENCES ad_campaigns(id);

CREATE TABLE ad_daily_stats (
  campaign_id uuid NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  day         date NOT NULL,
  impressions int NOT NULL DEFAULT 0,
  clicks      int NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, day)
);

-- ---------------------------------------------------------------------------
-- Analytics (rebuildable, never payment truth)
-- ---------------------------------------------------------------------------

CREATE TABLE listing_daily_stats (
  listing_id uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  day        date NOT NULL,
  views      int NOT NULL DEFAULT 0,
  saves      int NOT NULL DEFAULT 0,
  messages   int NOT NULL DEFAULT 0,
  offers     int NOT NULL DEFAULT 0,
  PRIMARY KEY (listing_id, day)
);

-- Deduplicates views per viewer per listing per day.
CREATE TABLE listing_view_dedupe (
  listing_id  uuid NOT NULL,
  viewer_hash text NOT NULL,
  day         date NOT NULL,
  PRIMARY KEY (listing_id, viewer_hash, day)
);

-- ---------------------------------------------------------------------------
-- Infrastructure: outbox, idempotency, rate limiting, audit
-- ---------------------------------------------------------------------------

CREATE TABLE outbox_events (
  id           bigserial PRIMARY KEY,
  topic        text NOT NULL,
  aggregate_id uuid,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key   text UNIQUE,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','done','dead')),
  attempts     int NOT NULL DEFAULT 0,
  last_error   text,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX outbox_events_pending_idx ON outbox_events (available_at, id) WHERE status = 'pending';

CREATE TABLE idempotency_records (
  scope        text NOT NULL,
  actor_id     text NOT NULL,
  key          text NOT NULL,
  request_hash text NOT NULL,
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, actor_id, key)
);

CREATE TABLE rate_limit_counters (
  bucket       text NOT NULL,
  window_start timestamptz NOT NULL,
  count        int NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

CREATE TABLE audit_events (
  id            bigserial PRIMARY KEY,
  actor_user_id uuid,
  actor_kind    text NOT NULL CHECK (actor_kind IN ('user','staff','system','provider','guest')),
  action        text NOT NULL,
  target_kind   text NOT NULL,
  target_id     text,
  reason        text,
  data          jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id    text,
  ip            text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_target_idx ON audit_events (target_kind, target_id, created_at DESC);
CREATE INDEX audit_events_actor_idx ON audit_events (actor_user_id, created_at DESC);
CREATE INDEX audit_events_action_idx ON audit_events (action, created_at DESC);
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Worker heartbeat (observability of background processing).
CREATE TABLE worker_heartbeats (
  worker_id   text PRIMARY KEY,
  task        text NOT NULL,
  last_run_at timestamptz NOT NULL DEFAULT now(),
  last_status text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb
);
