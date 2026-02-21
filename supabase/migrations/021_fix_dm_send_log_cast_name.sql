-- ==============================================
-- 021: dm_send_logのcast_name NULL一括修正
-- ==============================================

-- 1. campaignタグからcast_nameを推定して一括UPDATE
UPDATE dm_send_log
SET cast_name = 'hanshakun'
WHERE cast_name IS NULL
  AND (
    campaign ILIKE '%hansha%'
    OR campaign ILIKE '%はんしゃ%'
  );

UPDATE dm_send_log
SET cast_name = 'Risa_06'
WHERE cast_name IS NULL
  AND (
    campaign ILIKE '%risa%'
    OR campaign ILIKE '%リサ%'
  );

-- 2. campaignタグからキャスト特定できないものは、user_nameベースで推定
-- そのユーザーのcoin_transactionsで最も多いcast_nameを割り当てる
UPDATE dm_send_log d
SET cast_name = sub.dominant_cast
FROM (
  SELECT DISTINCT ON (ct.user_name)
    ct.user_name,
    ct.cast_name AS dominant_cast
  FROM coin_transactions ct
  WHERE ct.cast_name IS NOT NULL
  GROUP BY ct.user_name, ct.cast_name
  ORDER BY ct.user_name, SUM(ct.tokens) DESC
) sub
WHERE d.user_name = sub.user_name
  AND d.cast_name IS NULL;

-- 3. それでもNULLが残るケースの件数確認
SELECT COUNT(*) AS still_null FROM dm_send_log WHERE cast_name IS NULL;

-- 4. 残りのNULLはデフォルトでhanshakunに設定（メインキャスト）
-- 2キャストしかいないため、coin_transactionsに存在しないユーザー ≒ hanshakun宛
UPDATE dm_send_log SET cast_name = 'hanshakun' WHERE cast_name IS NULL;

-- 5. 最終確認
SELECT cast_name, COUNT(*) AS cnt
FROM dm_send_log
GROUP BY cast_name
ORDER BY cnt DESC;
