-- The episode script opens with a free-text intro above its topic cards.
ALTER TABLE podcast_episodes ADD COLUMN IF NOT EXISTS script_intro TEXT NOT NULL DEFAULT '';
