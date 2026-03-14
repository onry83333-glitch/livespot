-- Task A: paid_users UNIQUE制約にcast_name追加
-- 同じユーザーが複数キャストで課金した場合の区別を可能にする
ALTER TABLE paid_users DROP CONSTRAINT paid_users_account_id_user_name_key;
ALTER TABLE paid_users ADD CONSTRAINT paid_users_account_cast_user_key
  UNIQUE (account_id, cast_name, user_name);

-- Task B: dm_scenariosにcast_nameカラム追加
ALTER TABLE dm_scenarios ADD COLUMN cast_name TEXT;
UPDATE dm_scenarios SET cast_name = 'Risa_06' WHERE cast_name IS NULL;
