-- Morning Hook SaaS - Analytics RPC Functions
-- Migration 002: Stored functions for dashboard queries

-- ============================================================
-- daily_sales: 日別売上
-- ============================================================
CREATE OR REPLACE FUNCTION public.daily_sales(p_account_id UUID, p_since TEXT)
RETURNS TABLE(date TEXT, tokens BIGINT, tx_count BIGINT) AS $$
BEGIN
    RETURN QUERY
    SELECT
        to_char(ct.date AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD') AS date,
        SUM(ct.tokens)::BIGINT AS tokens,
        COUNT(*)::BIGINT AS tx_count
    FROM public.coin_transactions ct
    WHERE ct.account_id = p_account_id
      AND ct.date >= p_since::TIMESTAMPTZ
    GROUP BY 1
    ORDER BY 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- revenue_breakdown: 収入源内訳
-- ============================================================
CREATE OR REPLACE FUNCTION public.revenue_breakdown(p_account_id UUID, p_since TEXT)
RETURNS TABLE(type TEXT, tokens BIGINT, tx_count BIGINT, pct NUMERIC) AS $$
BEGIN
    RETURN QUERY
    WITH totals AS (
        SELECT SUM(ct.tokens) AS grand_total
        FROM public.coin_transactions ct
        WHERE ct.account_id = p_account_id AND ct.date >= p_since::TIMESTAMPTZ
    )
    SELECT
        ct.type,
        SUM(ct.tokens)::BIGINT AS tokens,
        COUNT(*)::BIGINT AS tx_count,
        ROUND(SUM(ct.tokens) * 100.0 / NULLIF(t.grand_total, 0), 1) AS pct
    FROM public.coin_transactions ct, totals t
    WHERE ct.account_id = p_account_id AND ct.date >= p_since::TIMESTAMPTZ
    GROUP BY ct.type, t.grand_total
    ORDER BY tokens DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- hourly_revenue: 時間帯分析 (JST)
-- ============================================================
CREATE OR REPLACE FUNCTION public.hourly_revenue(p_account_id UUID, p_since TEXT)
RETURNS TABLE(hour_jst INTEGER, tokens BIGINT, tx_count BIGINT) AS $$
BEGIN
    RETURN QUERY
    SELECT
        EXTRACT(HOUR FROM ct.date AT TIME ZONE 'Asia/Tokyo')::INTEGER AS hour_jst,
        SUM(ct.tokens)::BIGINT AS tokens,
        COUNT(*)::BIGINT AS tx_count
    FROM public.coin_transactions ct
    WHERE ct.account_id = p_account_id AND ct.date >= p_since::TIMESTAMPTZ
    GROUP BY 1
    ORDER BY 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- arpu_trend: 月別ARPU
-- ============================================================
CREATE OR REPLACE FUNCTION public.arpu_trend(p_account_id UUID)
RETURNS TABLE(month TEXT, arpu NUMERIC, unique_payers BIGINT, total_tokens BIGINT) AS $$
BEGIN
    RETURN QUERY
    SELECT
        to_char(ct.date AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM') AS month,
        ROUND(SUM(ct.tokens)::NUMERIC / NULLIF(COUNT(DISTINCT ct.user_name), 0), 1) AS arpu,
        COUNT(DISTINCT ct.user_name)::BIGINT AS unique_payers,
        SUM(ct.tokens)::BIGINT AS total_tokens
    FROM public.coin_transactions ct
    WHERE ct.account_id = p_account_id
    GROUP BY 1
    ORDER BY 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- retention_cohort: リテンション（最終支払月別）
-- ============================================================
CREATE OR REPLACE FUNCTION public.retention_cohort(p_account_id UUID)
RETURNS TABLE(last_paid_month TEXT, user_count BIGINT, avg_tokens NUMERIC) AS $$
BEGIN
    RETURN QUERY
    SELECT
        to_char(pu.last_paid AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM') AS last_paid_month,
        COUNT(*)::BIGINT AS user_count,
        ROUND(AVG(pu.total_tokens), 0) AS avg_tokens
    FROM public.paying_users pu
    WHERE pu.account_id = p_account_id
    GROUP BY 1
    ORDER BY 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- revenue_trend: 月別×タイプ別 収入源推移
-- ============================================================
CREATE OR REPLACE FUNCTION public.revenue_trend(p_account_id UUID)
RETURNS TABLE(month TEXT, type TEXT, tokens BIGINT) AS $$
BEGIN
    RETURN QUERY
    SELECT
        to_char(ct.date AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM') AS month,
        ct.type,
        SUM(ct.tokens)::BIGINT AS tokens
    FROM public.coin_transactions ct
    WHERE ct.account_id = p_account_id
    GROUP BY 1, 2
    ORDER BY 1, 2;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- top_users_detail: 太客詳細
-- ============================================================
CREATE OR REPLACE FUNCTION public.top_users_detail(p_account_id UUID, p_limit INTEGER DEFAULT 15)
RETURNS TABLE(
    user_name TEXT,
    total_tokens BIGINT,
    first_paid TIMESTAMPTZ,
    last_paid TIMESTAMPTZ,
    tx_count BIGINT,
    months_active INTEGER,
    primary_type TEXT
) AS $$
BEGIN
    RETURN QUERY
    WITH user_stats AS (
        SELECT
            ct.user_name,
            SUM(ct.tokens)::BIGINT AS total_tokens,
            MIN(ct.date) AS first_paid,
            MAX(ct.date) AS last_paid,
            COUNT(*)::BIGINT AS tx_count,
            (EXTRACT(YEAR FROM AGE(MAX(ct.date), MIN(ct.date))) * 12 +
             EXTRACT(MONTH FROM AGE(MAX(ct.date), MIN(ct.date))))::INTEGER + 1 AS months_active
        FROM public.coin_transactions ct
        WHERE ct.account_id = p_account_id
        GROUP BY ct.user_name
        ORDER BY total_tokens DESC
        LIMIT p_limit
    ),
    primary_types AS (
        SELECT DISTINCT ON (ct.user_name)
            ct.user_name,
            ct.type AS primary_type
        FROM public.coin_transactions ct
        WHERE ct.account_id = p_account_id
          AND ct.user_name IN (SELECT us.user_name FROM user_stats us)
        GROUP BY ct.user_name, ct.type
        ORDER BY ct.user_name, SUM(ct.tokens) DESC
    )
    SELECT
        us.user_name,
        us.total_tokens,
        us.first_paid,
        us.last_paid,
        us.tx_count,
        us.months_active,
        pt.primary_type
    FROM user_stats us
    LEFT JOIN primary_types pt ON us.user_name = pt.user_name
    ORDER BY us.total_tokens DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- dm_effectiveness: DM効果測定
-- ============================================================
CREATE OR REPLACE FUNCTION public.dm_effectiveness(p_account_id UUID, p_window_days INTEGER DEFAULT 7)
RETURNS TABLE(
    campaign TEXT,
    dm_sent_count BIGINT,
    reconverted_count BIGINT,
    conversion_rate NUMERIC,
    reconverted_tokens BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        d.campaign,
        COUNT(DISTINCT d.user_name)::BIGINT AS dm_sent_count,
        COUNT(DISTINCT c.user_name)::BIGINT AS reconverted_count,
        ROUND(
            COUNT(DISTINCT c.user_name)::NUMERIC * 100.0 /
            NULLIF(COUNT(DISTINCT d.user_name), 0),
            1
        ) AS conversion_rate,
        COALESCE(SUM(c.tokens), 0)::BIGINT AS reconverted_tokens
    FROM public.dm_send_log d
    LEFT JOIN public.coin_transactions c
        ON d.user_name = c.user_name
        AND c.account_id = d.account_id
        AND c.date BETWEEN d.sent_at AND d.sent_at + (p_window_days || ' days')::INTERVAL
        AND c.tokens > 0
    WHERE d.account_id = p_account_id
      AND d.status = 'success'
      AND d.campaign IS NOT NULL
      AND d.campaign != ''
    GROUP BY d.campaign
    ORDER BY conversion_rate DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
