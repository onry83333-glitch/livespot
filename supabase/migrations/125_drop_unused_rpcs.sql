-- Migration 125: 未使用RPC関数の削除 (18個)
-- 対象: frontend/src, collector/src のどちらからも呼ばれていない関数
-- 調査方法: 全RPC定義を migrations から抽出 → フロント/コレクターで grep → 0件のものを抽出
-- 判断基準: 002_で作られた旧世代分析 + どこからも呼ばれていないget_関数 + 後継に置換済み関数
--
-- ROLLBACK手順:
-- 各関数を元のマイグレーションから再作成する
-- 002系: \i supabase/migrations/078_fix_cast_name_filters_v2.sql
-- その他: 各コメントに記載の元マイグレーションを参照

-- ============================================================
-- 1) 002_analytics_functions.sql 由来の旧世代関数 (8個)
--    078_fix_cast_name_filters_v2.sql で p_cast_name 引数追加版に書き直されたが
--    フロント/コレクターのどちらからも未呼出
-- ============================================================
DROP FUNCTION IF EXISTS daily_sales(UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS revenue_breakdown(UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS hourly_revenue(UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS arpu_trend(UUID, TEXT);
DROP FUNCTION IF EXISTS retention_cohort(UUID, TEXT);
DROP FUNCTION IF EXISTS revenue_trend(UUID, TEXT);
DROP FUNCTION IF EXISTS top_users_detail(UUID, INTEGER, TEXT);
DROP FUNCTION IF EXISTS dm_effectiveness(UUID, INTEGER, TEXT);

-- 002_オリジナル版（引数少ない旧シグネチャ）も念のため削除
DROP FUNCTION IF EXISTS daily_sales(UUID, TEXT);
DROP FUNCTION IF EXISTS revenue_breakdown(UUID, TEXT);
DROP FUNCTION IF EXISTS hourly_revenue(UUID, TEXT);
DROP FUNCTION IF EXISTS arpu_trend(UUID);
DROP FUNCTION IF EXISTS retention_cohort(UUID);
DROP FUNCTION IF EXISTS revenue_trend(UUID);
DROP FUNCTION IF EXISTS top_users_detail(UUID, INTEGER);
DROP FUNCTION IF EXISTS dm_effectiveness(UUID, INTEGER);

-- ============================================================
-- 2) get_関数: フロント/コレクターから呼び出しゼロ (6個)
-- ============================================================

-- 044_spy_viewers.sql 由来。フロント/コレクター/バックエンドのいずれからも未呼出
DROP FUNCTION IF EXISTS get_dm_funnel(UUID, TEXT, TIMESTAMPTZ);

-- 065_spy_analysis_rpcs.sql / 100_v2_rpc_switch.sql 由来。どこからも未呼出
DROP FUNCTION IF EXISTS get_goal_achievement_analysis(UUID, TEXT, INTEGER);

-- 006_analytics_rpc.sql 由来。get_session_list / get_session_list_v2 に置換済み
DROP FUNCTION IF EXISTS get_cast_sessions(UUID, TEXT, DATE);

-- 006_analytics_rpc.sql 由来。detect_new_paying_users に置換済み
DROP FUNCTION IF EXISTS detect_new_tippers(UUID, TEXT, TIMESTAMPTZ);

-- 025_competitive_analysis_rpc.sql 由来。フロント/コレクター未使用
DROP FUNCTION IF EXISTS get_cast_ranking(UUID, TEXT, INTEGER);

-- 025_competitive_analysis_rpc.sql 由来。フロント/コレクター未使用
DROP FUNCTION IF EXISTS get_viewer_trend(UUID, TEXT[], TEXT);

-- ============================================================
-- 3) 後継関数に置換済みの旧版 (4個)
-- ============================================================

-- 016/100_v2_rpc_switch.sql 由来。get_user_acquisition_dashboard に統合済み
DROP FUNCTION IF EXISTS search_user_detail(UUID, TEXT, TEXT);

-- 069_dm_cleanup_and_dedup.sql 由来。080_test_data_management の count_test_data に置換
DROP FUNCTION IF EXISTS count_test_dm_data(UUID);

-- 069_dm_cleanup_and_dedup.sql 由来。080_test_data_management の delete_test_data に置換
DROP FUNCTION IF EXISTS cleanup_test_dm_data(UUID);

-- 020_check_data_integrity.sql 由来。074_check_spy_data_quality に置換
DROP FUNCTION IF EXISTS check_data_integrity(TIMESTAMPTZ);
