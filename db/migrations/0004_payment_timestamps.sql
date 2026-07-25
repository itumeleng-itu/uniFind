-- The P&L needs to recognise a sale on the day it was paid and reverse a
-- refund on the day it was actually refunded -- updated_at alone can't do
-- this, since a refund overwrites it and the original paid date is lost.
ALTER TABLE payments ADD COLUMN paid_at timestamptz;
ALTER TABLE payments ADD COLUMN refunded_at timestamptz;
