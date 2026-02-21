-- 028: spy_messages に user_league / user_level カラム追加
-- user_league: Stripchat league名 (grey, bronze, silver, gold, diamond, royal, legend)
-- user_level: ユーザーレベル数値 (1-100)
-- content_spy.js が DOM の color-league-{name} クラスから抽出

ALTER TABLE spy_messages ADD COLUMN IF NOT EXISTS user_league TEXT DEFAULT NULL;
ALTER TABLE spy_messages ADD COLUMN IF NOT EXISTS user_level INTEGER DEFAULT NULL;

COMMENT ON COLUMN spy_messages.user_league IS 'Stripchat league名 (grey/bronze/silver/gold/diamond/royal/legend)。DOMのcolor-league-{name}クラスから抽出';
COMMENT ON COLUMN spy_messages.user_level IS 'Stripchatユーザーレベル (1-100)。DOM内のレベルバッジから抽出';
