-- 005: durable request limits (sign-in attempts, collector ingestion, expensive imports).
-- Additive only. Keys are HMAC hashes of the client address or the signed-in Google subject, never raw values.
create table if not exists rate_limits (
  bucket text not null check (length(bucket) between 1 and 200),
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (bucket, window_start)
);
create index if not exists rate_limits_window_idx on rate_limits (window_start);
