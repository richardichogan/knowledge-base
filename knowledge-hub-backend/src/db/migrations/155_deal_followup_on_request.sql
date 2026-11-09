-- Deal desk keeps suggested follow-up wording; the draft is created only when Richard asks for it.
ALTER TABLE deal_desk_updates ADD COLUMN IF NOT EXISTS follow_up jsonb;
