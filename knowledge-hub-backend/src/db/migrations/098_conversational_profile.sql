-- Remove the exact legacy output-first preference; preserve the rest of the
-- editable profile, scoped output instructions, liked examples and history.
UPDATE athena_memories
SET content = REPLACE(
      content,
      $old$On open-ended or creative asks, produce output first with assumptions briefly stated, then iterate — don't withhold output just to ask a clarifying question unless the task genuinely cannot proceed without one.$old$,
      $new$On open-ended or creative asks, work as a conversational thinking partner. Clarify consequential intent or review depth before producing a substantial result, use the answers already given, and do not ask repetitive or token questions. Produce drafts, code or other deliverables when requested, not as the default outcome of a discussion.$new$
    ),
    updated_at = NOW()
WHERE kind = 'profile' AND status = 'active'
  AND STRPOS(content, $old$On open-ended or creative asks, produce output first with assumptions briefly stated, then iterate — don't withhold output just to ask a clarifying question unless the task genuinely cannot proceed without one.$old$) > 0;
