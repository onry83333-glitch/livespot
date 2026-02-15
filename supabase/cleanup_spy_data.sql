-- ============================================
-- Strip Live Spot データクリーンアップ
-- Supabase SQL Editor で実行
-- 実行前に SELECT で確認してから DELETE する
-- ============================================

-- 1. 500文字超の異常メッセージを確認
SELECT id, message_time, user_name, LEFT(message, 100) as msg_preview,
       LENGTH(message) as msg_length, msg_type
FROM spy_messages
WHERE account_id = '940e7248-1d73-4259-a538-56fdaea9d740'
AND LENGTH(message) > 500
ORDER BY created_at DESC;

-- 2. メッセージ=ユーザー名の不正データを確認
SELECT id, message_time, user_name, message, msg_type
FROM spy_messages
WHERE account_id = '940e7248-1d73-4259-a538-56fdaea9d740'
AND message = user_name
AND msg_type = 'chat'
ORDER BY created_at DESC;

-- 3. ユーザー名に数字プレフィックスが付いた旧バグデータを確認
-- （注意: 正規ユーザー名が数字始まりの場合もあるので目視確認必要）
SELECT id, message_time, user_name, LEFT(message, 50) as msg_preview
FROM spy_messages
WHERE account_id = '940e7248-1d73-4259-a538-56fdaea9d740'
AND user_name ~ '^\d{1,3}[A-Za-z]'
AND LENGTH(user_name) > 15
ORDER BY created_at DESC
LIMIT 50;

-- 4. 完全重複の確認
SELECT message_time, user_name, message, msg_type, COUNT(*) as cnt
FROM spy_messages
WHERE account_id = '940e7248-1d73-4259-a538-56fdaea9d740'
GROUP BY message_time, user_name, message, msg_type
HAVING COUNT(*) > 1
ORDER BY cnt DESC
LIMIT 20;

-- ============================================
-- 確認後、不正データを削除（慎重に実行）
-- コメントを外して1つずつ実行
-- ============================================

-- 500文字超の連結バグデータを削除
-- DELETE FROM spy_messages
-- WHERE account_id = '940e7248-1d73-4259-a538-56fdaea9d740'
-- AND LENGTH(message) > 500;

-- メッセージ=ユーザー名のデータを削除
-- DELETE FROM spy_messages
-- WHERE account_id = '940e7248-1d73-4259-a538-56fdaea9d740'
-- AND message = user_name
-- AND msg_type = 'chat';

-- 重複データの削除（各グループの最新1件を残す）
-- DELETE FROM spy_messages a
-- USING spy_messages b
-- WHERE a.account_id = '940e7248-1d73-4259-a538-56fdaea9d740'
-- AND a.message_time = b.message_time
-- AND a.user_name IS NOT DISTINCT FROM b.user_name
-- AND a.message IS NOT DISTINCT FROM b.message
-- AND a.msg_type = b.msg_type
-- AND a.id < b.id;
