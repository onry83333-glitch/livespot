-- cast_plans: 1日1件のUNIQUE制約を削除して、1日に複数メモを保存可能にする
ALTER TABLE cast_plans DROP CONSTRAINT IF EXISTS cast_plans_account_id_cast_name_plan_date_key;
