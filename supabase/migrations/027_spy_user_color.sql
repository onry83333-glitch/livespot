-- 027: spy_messages に user_color カラム追加
-- ユーザーネームの色情報（Stripchat累計課金額に応じた色）を格納
-- content_spy.js が getComputedStyle で取得した HEX/RGB カラー値

ALTER TABLE spy_messages ADD COLUMN IF NOT EXISTS user_color TEXT;

COMMENT ON COLUMN spy_messages.user_color IS 'Stripchatのユーザーネーム色（累計課金額に応じた色分け）。content_spy.jsがDOMから取得したCSS color値';
