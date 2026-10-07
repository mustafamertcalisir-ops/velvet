-- 0011 — QA accounts (DEC-076).
--
-- Staging carries isolated QA accounts: the smoke flow, the staging journey
-- and the QA seed sign in with designated TEST numbers (SMS_TEST_NUMBERS,
-- refused in production by configuration). Such accounts are marked at
-- creation and:
--   * are the only applications the staging review fixture may move
--     (POST /internal/test/review — absent in production);
--   * never meet non-QA members in Dating introductions, and non-QA members
--     never meet them (human testers and QA accounts stay apart).
-- In production no number is a test number, so no account is ever marked.
-- The flag is internal: it is never part of any applicant or member response.

ALTER TABLE app.accounts ADD COLUMN qa_account boolean NOT NULL DEFAULT false;
