-- Note and document indexing failed because the optional passage index did not
-- exist. Indexing now skips missing passage indexes, so retry those jobs once.
UPDATE knowledge_indexing_work
   SET status = 'pending', attempts = 0, error_code = NULL, lease_token = NULL,
       lease_expires_at = NULL, next_attempt_at = now(), updated_at = now()
 WHERE ref_kind = 'content_item' AND status = 'failed' AND operation = 'index';
