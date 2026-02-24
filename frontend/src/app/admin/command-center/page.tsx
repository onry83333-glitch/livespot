'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';

// ══════════════════════════════════════
//  THEME TOKENS
// ══════════════════════════════════════
const TK: Record<string, Record<string, string>> = {
  dark: {
    bg: "#080a10", sf: "#0d1118", card: "#11141e", cardAlt: "#161a26",
    bdr: "#1c2030", bdrLit: "#272e42",
    pri: "#00e0b8", priDim: "rgba(0,224,184,.07)", priGlow: "rgba(0,224,184,.22)",
    red: "#ff5c6c", redDim: "rgba(255,92,108,.09)",
    amb: "#ffb347", ambDim: "rgba(255,179,71,.09)",
    pur: "#a78bfa", purDim: "rgba(167,139,250,.10)",
    cyn: "#22d3ee", cynDim: "rgba(34,211,238,.09)",
    txt: "#e4e9f2", mid: "#7e8aa2", dim: "#485166",
    bar: "#0b0d15", barBdr: "#181d2c",
    sh: "0 1px 4px rgba(0,0,0,.45)", csh: "0 2px 10px rgba(0,0,0,.32)",
  },
  light: {
    bg: "#f3f4f8", sf: "#ffffff", card: "#ffffff", cardAlt: "#f8f9fc",
    bdr: "#dfe2ea", bdrLit: "#ccd1dd",
    pri: "#069980", priDim: "rgba(6,153,128,.06)", priGlow: "rgba(6,153,128,.16)",
    red: "#dc3e50", redDim: "rgba(220,62,80,.07)",
    amb: "#c88520", ambDim: "rgba(200,133,32,.07)",
    pur: "#7c5cc0", purDim: "rgba(124,92,192,.07)",
    cyn: "#0988ae", cynDim: "rgba(9,136,174,.07)",
    txt: "#181c2a", mid: "#5b6478", dim: "#9ca3b4",
    bar: "#ffffff", barBdr: "#e3e6ee",
    sh: "0 1px 3px rgba(0,0,0,.05)", csh: "0 2px 8px rgba(0,0,0,.04)",
  },
};

// ══════════════════════════════════════
//  STATIC BUSINESS DATA
// ══════════════════════════════════════
const phases = [
  { name: "Phase 1: データ収集基盤", pct: 85, stg: 3, tag: "展開", clr: "pri" },
  { name: "Phase 2: 分析エージェント", pct: 38, stg: 2, tag: "設計", clr: "amb" },
  { name: "Phase 3: 戦略生成+コーチング", pct: 15, stg: 1, tag: "初期", clr: "pur" },
  { name: "Phase 4: 統合+スケール", pct: 5, stg: 1, tag: "初期", clr: "red" },
];
const stgNames = ["初期", "設計", "展開", "拡張", "完了"];

const blockers = [
  { t: "SPY自動巡回（他社）", d: "ミニPC + 自動切替ロジックが必要", s: "高" },
  { t: "ファイナンス自動同期", d: "Supabase → Notion 自動転記", s: "高" },
  { t: "ミニPC到着・セットアップ", d: "24時間稼働の前提条件", s: "中" },
];

const conns = [
  { n: "Supabase DB", st: "同期済", dt: "遅延 12ms", ic: "\u229F", ok: true },
  { n: "Notion ドキュメント", st: "更新済", dt: "2分前", ic: "\u22A1", ok: true },
];

const logs = [
  { clr: "pur", ti: "コイン同期完了", ds: "はんしゃくん: 400件アップサート", tm: "15:42 UTC" },
  { clr: "cyn", ti: "セグメント更新", ds: "10セグメント再計算完了", tm: "14:30 UTC" },
  { clr: "dim", ti: "コンテキスト巡回", ds: "Notionの4ブロックを自動更新", tm: "13:15 UTC" },
];

// pipes: Supabase pipeline_status から動的取得（後述のuseEffectで読み込み）

const projs = [
  { n: "Strip Live Spot", tg: "稼働中", c: "pri", st: "19マイグレーション \u00B7 12テーブル \u00B7 Chrome v2.2.0" },
  { n: "北関東自動化OS", tg: "開発中", c: "cyn", st: "3エンジン \u00B7 264名 \u00B7 クローラー" },
  { n: "採用LP / WordPress", tg: "稼働中", c: "amb", st: "54記事 \u00B7 漫画LP \u00B7 LINE" },
  { n: "DMCA Shield", tg: "待機中", c: "dim", st: "7ページ \u00B7 認証済 \u00B7 API未実装" },
  { n: "国内チャットレディ展開", tg: "企画中", c: "pur", st: "FANZA/チャットピア \u00B7 代理店加入済" },
];

const sDot: Record<string, string> = { auto: "#00d68f", semi: "#ffc048", manual: "#ff8a40", off: "#ff5c6c" };
const sLbl: Record<string, string> = { auto: "自動", semi: "半自動", manual: "手動", off: "未設定" };
const sevC: Record<string, string> = { "\u7DCA\u6025": "red", "\u9AD8": "amb", "\u4E2D": "dim" };

// ══════════════════════════════════════
//  TAB 1: STRATEGY DATA
// ══════════════════════════════════════
const phaseDetails = [
  {
    id: 1, name: "フェーズ1: データ収集基盤", pct: 85, clr: "pri",
    goal: "TOP20-30人の配信データが24時間自動蓄積される状態",
    done: ["SPYリアルタイム監視", "コイン同期（キャスト選択UI実装済）", "STT音声文字起こし（faster-whisper）", "10セグメント分類", "DM一斉送信パイプライン", "キャスト選択UI", "SPY自動巡回（自社）— 3分ポーリング実装済", "マイナストークン生成バグ修正 — 4層防御実装済", "コイン同期自動発火 — chrome.alarms 3トリガー実装済"],
    remaining: [
      { task: "SPY自動巡回（他社）", blocker: "ミニPC + 自動切替ロジック", priority: "P0" },
    ],
  },
  {
    id: 2, name: "フェーズ2: 分析エージェント", pct: 38, clr: "amb",
    goal: "週次成功パターン分析レポートが自動生成される状態",
    done: ["AI配信FBレポート基盤", "DM CVR分析", "セグメント分析"],
    remaining: [
      { task: "競合分析RPC", blocker: "SPYログデータ蓄積待ち", priority: "P1" },
      { task: "成功パターン構造化DB", blocker: "競合データ不足", priority: "P2" },
      { task: "週次自動レポート生成", blocker: "Claude API + cron", priority: "P2" },
    ],
  },
  {
    id: 3, name: "フェーズ3: 戦略生成+コーチング", pct: 15, clr: "pur",
    goal: "台本→配信→FBサイクルがAIだけで回る状態",
    done: ["安藤式7原則の体系化", "コンテンツ6技法のDB化", "ナレッジベース12ページ完成"],
    remaining: [
      { task: "台本自動生成エンジン", blocker: "フェーズ2の成功パターンDB", priority: "P2" },
      { task: "ゴール最適化提案", blocker: "過去データの統計分析", priority: "P2" },
      { task: "リアルタイムコーチング", blocker: "ルールエンジン設計", priority: "P3" },
      { task: "お礼DM自動送信", blocker: "ギフト検出→DMキュー", priority: "P1" },
    ],
  },
  {
    id: 4, name: "フェーズ4: 統合+スケール", pct: 5, clr: "red",
    goal: "YUUTA不在3日間で売上70%以上維持",
    done: ["COO/PMエージェント構想設計"],
    remaining: [
      { task: "全エージェント統括ロジック", blocker: "フェーズ1-3の安定稼働", priority: "P3" },
      { task: "採用ファネル自動化", blocker: "広告配信開始 + LINE連携", priority: "P2" },
      { task: "国内サイト展開", blocker: "要件定義 → クリエイティブ整備", priority: "P2" },
    ],
  },
];

const andoPrinciples = [
  { num: 1, title: "課金は「応援」である", desc: "お金を払う行為を取引ではなく関係性として捉える" },
  { num: 2, title: "毎日の接点が信頼を作る", desc: "日次のエンゲージメントフックで常連化を促進" },
  { num: 3, title: "選別・育成・信頼の3段階", desc: "セグメント別にDM戦略を最適化" },
  { num: 4, title: "BYAF法でDMを送る", desc: "「でもあなたの自由です」で押し付け感を排除" },
  { num: 5, title: "ゴールは導線の入口", desc: "ticketShow→DM→高額への自然な流れ" },
  { num: 6, title: "逆アンカリング", desc: "低価格で期待値超え→次回高額ゴールへ導線" },
  { num: 7, title: "循環ループを回す", desc: "DM→来場→tip→ticketShow→個人リクエスト" },
];

const priClr: Record<string, string> = { P0: "red", P1: "amb", P2: "cyn", P3: "dim" };

// pipeDetails: Supabase pipeline_status から動的取得（pipesと共通データ源）

const sysStatus = [
  { n: "Supabase接続", st: "正常", dt: "遅延 12ms", ok: true },
  { n: "Notion同期", st: "更新済", dt: "2分前", ok: true },
  { n: "Chrome拡張", st: "v2.2.0", dt: "接続済", ok: true },
  { n: "ミニPC", st: "未接続", dt: "セットアップ待ち", ok: false },
];

// ══════════════════════════════════════
//  TAB 3: ASSETS DATA
// ══════════════════════════════════════
const projectDetails = [
  {
    n: "Strip Live Spot", tg: "稼働中", c: "pri", icon: "💻",
    desc: "Stripchat配信分析・管理SaaS",
    stats: [{ label: "マイグレーション", val: "001-019" }, { label: "テーブル", val: "12 + 8 RPC" }, { label: "Chrome拡張", val: "v2.2.0" }, { label: "登録キャスト", val: "2名" }],
    url: "livespot-rouge.vercel.app",
  },
  {
    n: "北関東自動化OS", tg: "開発中", c: "cyn", icon: "🖥️",
    desc: "スカウト・育成・売上の完全自動化",
    stats: [{ label: "エンジン", val: "3基" }, { label: "スカウト", val: "264名" }, { label: "クローラー", val: "\u00A58.68/回" }, { label: "移行先", val: "ミニPC" }],
    url: null,
  },
  {
    n: "採用LP / WordPress", tg: "稼働中", c: "amb", icon: "🌐",
    desc: "キャスト採用ファネル",
    stats: [{ label: "記事数", val: "54本" }, { label: "LP", val: "漫画7枚" }, { label: "LINE", val: "エルメ設計済" }, { label: "広告", val: "アカウント作成済" }],
    url: null,
  },
  {
    n: "DMCA Shield", tg: "待機中", c: "dim", icon: "🛡️",
    desc: "著作権保護自動化ツール",
    stats: [{ label: "ページ", val: "7P" }, { label: "認証", val: "完了" }, { label: "API", val: "未実装" }, { label: "DB", val: "Singapore nano" }],
    url: null,
  },
  {
    n: "国内チャットレディ展開", tg: "企画中", c: "pur", icon: "🇯🇵",
    desc: "FANZA/チャットピア 新人練習場所",
    stats: [{ label: "サイト", val: "FANZA/チャットピア" }, { label: "代理店", val: "加入済" }, { label: "マニュアル", val: "PDF入手済" }, { label: "位置付け", val: "練習場所 + 受け皿" }],
    url: null,
  },
];

const techStack = [
  { cat: "フロントエンド", items: "Next.js \u00B7 React \u00B7 Tailwind CSS \u00B7 Vercel" },
  { cat: "バックエンド", items: "Supabase (東京) \u00B7 PostgreSQL \u00B7 RPC関数" },
  { cat: "拡張機能", items: "Chrome Extension v2.2.0 \u00B7 Supabase JS SDK" },
  { cat: "AI/ML", items: "Claude API \u00B7 faster-whisper (STT) \u00B7 Context Crawler" },
  { cat: "自動化", items: "Python \u00B7 cron \u00B7 ミニPC (予定)" },
  { cat: "外部連携", items: "Notion API \u00B7 Stripchat API \u00B7 LINE/エルメ" },
];

// ══════════════════════════════════════
//  MAIN COMPONENT
// ══════════════════════════════════════
export default function CommandCenterPage() {
  const [mode, setMode] = useState("dark");
  const [activeNav, setActiveNav] = useState(0);
  const [expandedPhase, setExpandedPhase] = useState<number | null>(0);
  const [revenue, setRevenue] = useState({ thisWeek: 0, lastWeek: 0, activeCasts: 0 });
  const [pipelines, setPipelines] = useState<{ id: number; pipeline_name: string; status: string; source: string | null; destination: string | null; detail: string | null; last_run_at: string | null; last_success: boolean }[]>([]);

  // P0-4: テストデータ削除
  const [testDataCount, setTestDataCount] = useState<{ test_count: number; bulk_count: number; total: number } | null>(null);
  const [testDataLoading, setTestDataLoading] = useState(false);
  const [testDataDeleting, setTestDataDeleting] = useState(false);
  const [testDataConfirm, setTestDataConfirm] = useState(false);
  const [testDataResult, setTestDataResult] = useState<string | null>(null);

  const t = TK[mode];
  const g = useCallback((k: string) => t[k] || k, [t]);
  const ff = "'DM Sans', 'Segoe UI', system-ui, sans-serif";
  const fm = "'JetBrains Mono', 'Fira Code', monospace";

  // ── Supabase client ──
  const supabase = useMemo(() => createClient(), []);

  useEffect(() => {
    const fetchRevenue = async () => {
      try {
        // 週境界: 月曜03:00 JST（送金サイクル区切り）
        const now = new Date();
        const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
        const day = jst.getUTCDay();
        const hour = jst.getUTCHours();
        let diff = day === 0 ? 6 : day - 1;
        if (day === 1 && hour < 3) diff = 7;
        const monday = new Date(jst);
        monday.setUTCDate(jst.getUTCDate() - diff);
        monday.setUTCHours(3, 0, 0, 0);
        const weekStart = new Date(monday.getTime() - 9 * 60 * 60 * 1000);
        const lastWeekStart = new Date(weekStart.getTime() - 7 * 24 * 60 * 60 * 1000);

        const { data: thisWeekData } = await supabase
          .from('coin_transactions')
          .select('tokens')
          .gte('date', weekStart.toISOString());

        const thisWeekTotal = (thisWeekData || []).reduce((sum: number, r: { tokens: number }) => sum + (r.tokens || 0), 0);

        const { data: lastWeekData } = await supabase
          .from('coin_transactions')
          .select('tokens')
          .gte('date', lastWeekStart.toISOString())
          .lt('date', weekStart.toISOString());

        const lastWeekTotal = (lastWeekData || []).reduce((sum: number, r: { tokens: number }) => sum + (r.tokens || 0), 0);

        const { data: casts } = await supabase
          .from('registered_casts')
          .select('cast_name')
          .eq('is_active', true);

        setRevenue({
          thisWeek: thisWeekTotal,
          lastWeek: lastWeekTotal,
          activeCasts: casts?.length || 0,
        });
      } catch (e) {
        console.error('Revenue fetch error:', e);
      }
    };
    fetchRevenue();
  }, [supabase]);

  // ── Pipeline status fetch (60s polling) ──
  useEffect(() => {
    const fetchPipelines = async () => {
      try {
        await supabase.rpc('update_pipeline_auto_status');
      } catch { /* RPC未作成でも続行 */ }
      const { data } = await supabase
        .from('pipeline_status')
        .select('*')
        .order('id');
      if (data) setPipelines(data);
    };
    fetchPipelines();
    const iv = setInterval(fetchPipelines, 60000);
    return () => clearInterval(iv);
  }, [supabase]);

  // ── P0-4: テストデータ件数チェック ──
  const handleCountTestData = useCallback(async () => {
    setTestDataLoading(true);
    setTestDataResult(null);
    try {
      const { data, error } = await supabase.rpc('count_test_dm_data', {});
      if (error) throw error;
      setTestDataCount(data);
    } catch (e: unknown) {
      setTestDataResult(`エラー: ${e instanceof Error ? e.message : '不明'}`);
    }
    setTestDataLoading(false);
  }, [supabase]);

  // ── P0-4: テストデータ削除実行 ──
  const handleDeleteTestData = useCallback(async () => {
    setTestDataDeleting(true);
    setTestDataResult(null);
    setTestDataConfirm(false);
    try {
      const { data, error } = await supabase.rpc('cleanup_test_dm_data', {});
      if (error) throw error;
      setTestDataResult(`${data.deleted}件のテストデータを削除しました (${new Date().toLocaleTimeString('ja-JP')})`);
      setTestDataCount(null);
    } catch (e: unknown) {
      setTestDataResult(`削除エラー: ${e instanceof Error ? e.message : '不明'}`);
    }
    setTestDataDeleting(false);
  }, [supabase]);

  // ── Derived pipe arrays ──
  const pipes = pipelines.map(p => ({ n: p.pipeline_name, s: p.status, d: p.detail || '' }));
  const pipeDetails = pipelines.map(p => ({ n: p.pipeline_name, s: p.status, from: p.source || '', to: p.destination || '', d: p.detail || '' }));

  const revenueYen = Math.round(revenue.thisWeek * 7.7);
  const revenueChange = revenue.lastWeek > 0
    ? ((revenue.thisWeek - revenue.lastWeek) / revenue.lastWeek * 100).toFixed(1)
    : '\u2014';

  const autoCount = pipes.filter(p => p.s === 'auto').length;
  const semiCount = pipes.filter(p => p.s === 'semi').length;
  const manualCount = pipes.filter(p => p.s === 'manual').length;
  const automationPct = pipes.length > 0 ? Math.round((autoCount * 100 + semiCount * 50) / pipes.length) : 0;

  const kpis = [
    { label: "売上", val: `\u00A5${revenueYen.toLocaleString()}`, sub: `${revenueChange}% 先週比`, ico: "\u2197", clr: "pri" },
    { label: "全体進捗", val: "36%", sub: "デプロイ中: フェーズ2", ico: null as string | null, clr: "pri", bar: 36 },
    { label: "自動化率", val: `${automationPct}%`, sub: `${autoCount} 自動 \u00B7 ${semiCount} 半自動 \u00B7 ${manualCount} 手動`, ico: "\u26A1", clr: "cyn" },
    { label: "稼働キャスト", val: `${revenue.activeCasts}`, sub: "現在配信中", ico: "\u229E", clr: "pur" },
  ];

  const Card = ({ children, style = {} }: { children: React.ReactNode; style?: React.CSSProperties }) => (
    <div style={{ background: g("card"), border: `1px solid ${g("bdr")}`, borderRadius: 12, boxShadow: g("csh"), ...style }}>{children}</div>
  );

  return (
    <div style={{ fontFamily: ff, background: g("bg"), color: g("txt"), minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet" />

      {/* TOP BAR */}
      <header style={{
        height: 54, background: g("bar"), borderBottom: `1px solid ${g("barBdr")}`,
        display: "flex", alignItems: "center", padding: "0 20px", gap: 28,
        position: "sticky", top: 0, zIndex: 100, boxShadow: g("sh"),
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 150 }}>
          <div style={{
            width: 28, height: 28, borderRadius: 7,
            background: `linear-gradient(135deg, ${g("pri")}, ${g("pur")})`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 13, fontWeight: 900, color: "#fff",
          }}>W</div>
          <span style={{ fontWeight: 800, fontSize: 15, letterSpacing: "-0.3px" }}>Wisteria OS</span>
        </div>
        <nav style={{ display: "flex", gap: 2 }}>
          {["コマンド", "戦略", "オペレーション", "アセット"].map((n, i) => (
            <button key={n} onClick={() => setActiveNav(i)} style={{
              background: "none", border: "none", cursor: "pointer", fontFamily: ff,
              fontSize: 13, fontWeight: i === activeNav ? 700 : 500,
              color: i === activeNav ? g("pri") : g("mid"),
              padding: "6px 14px", borderRadius: 6,
              borderBottom: i === activeNav ? `2px solid ${g("pri")}` : "2px solid transparent",
            }}>{n}</button>
          ))}
        </nav>
        <div style={{ flex: 1 }} />
        <button onClick={() => setMode(m => m === "dark" ? "light" : "dark")} style={{
          background: g("priDim"), border: `1px solid ${g("bdr")}`, borderRadius: 8,
          width: 34, height: 34, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 15, color: g("mid"),
        }}>{mode === "dark" ? "\u2600" : "\u263E"}</button>
        <div style={{
          width: 32, height: 32, borderRadius: "50%",
          background: `linear-gradient(135deg, ${g("pri")}, ${g("cyn")})`,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 12, fontWeight: 800, color: "#fff",
        }}>Y</div>
      </header>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* SIDEBAR */}
        <aside style={{
          width: 52, background: g("bar"), borderRight: `1px solid ${g("barBdr")}`,
          display: "flex", flexDirection: "column", alignItems: "center",
          padding: "14px 0", gap: 6, flexShrink: 0,
        }}>
          {["\u229E", "\uD83D\uDCCA", "\u2699", "\u2630"].map((ic, i) => (
            <button key={i} onClick={() => setActiveNav(i)} style={{
              width: 36, height: 36, borderRadius: 9, border: "none", cursor: "pointer",
              background: i === activeNav ? g("priDim") : "transparent",
              color: i === activeNav ? g("pri") : g("dim"), fontSize: 16,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>{ic}</button>
          ))}
        </aside>

        {/* MAIN */}
        <main style={{ flex: 1, padding: "22px 26px", overflowY: "auto" }}>

          {/* ═══ TAB 0: コマンド ═══ */}
          {activeNav === 0 && (<>
          {/* KPI */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 22 }}>
            {kpis.map((k, i) => (
              <Card key={i} style={{ padding: "16px 18px", ...(k.bar != null ? { borderColor: g("pri"), borderWidth: "1.5px" } : {}) }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "1.2px", color: g("mid") }}>{k.label}</span>
                  {k.ico && <span style={{ fontSize: 13, color: g(k.clr), opacity: 0.8 }}>{k.ico}</span>}
                </div>
                <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.8px", marginBottom: k.bar != null ? 6 : 4 }}>{k.val}</div>
                {k.bar != null && (
                  <div style={{ height: 4, background: g("bdr"), borderRadius: 2, marginBottom: 8, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${k.bar}%`, background: g("pri"), borderRadius: 2 }} />
                  </div>
                )}
                <div style={{ fontSize: 11, color: k.clr === "pri" ? g("pri") : g("mid") }}>{k.sub}</div>
              </Card>
            ))}
          </div>

          {/* 2-COL */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 330px", gap: 18 }}>
            {/* LEFT */}
            <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
              {/* MISSION CONTROL */}
              <Card style={{ padding: "18px 22px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 18 }}>
                  <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "1.5px", color: g("pri") }}>{"\u2699"} ミッション管制グリッド</span>
                  <span style={{ fontSize: 11, color: g("mid"), fontWeight: 600, cursor: "pointer" }}>全ノード表示</span>
                </div>
                {phases.map((p, i) => (
                  <div key={i} style={{ marginBottom: i < phases.length - 1 ? 18 : 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 7 }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{p.name}</span>
                      <span style={{ fontSize: 11, fontWeight: 700, color: g(p.clr), fontFamily: fm }}>{p.tag} ({p.pct}%)</span>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 3, height: 8 }}>
                      {stgNames.map((_, si) => (
                        <div key={si} style={{
                          borderRadius: 2,
                          background: si < p.stg ? (si === p.stg - 1 ? g(p.clr) : g(p.clr) + (mode === "dark" ? "70" : "50")) : g("bdr"),
                        }} />
                      ))}
                    </div>
                    {i === 0 && (
                      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                        {stgNames.map((s, si) => (
                          <span key={si} style={{ fontSize: 9, fontFamily: fm, fontWeight: si === 2 ? 700 : 400, color: si === 2 ? g("pri") : g("dim") }}>{s}</span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </Card>

              {/* CONNECTORS */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                {conns.map((cn, i) => (
                  <Card key={i} style={{ padding: "14px 16px", display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ width: 40, height: 40, borderRadius: 9, background: g("priDim"), display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17, color: g("pri") }}>{cn.ic}</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>{cn.n}</div>
                      <div style={{ fontSize: 11, color: g("mid"), display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: cn.ok ? g("pri") : g("red"), display: "inline-block" }} />
                        {cn.st} {"\u00B7"} {cn.dt}
                      </div>
                    </div>
                  </Card>
                ))}
              </div>

              {/* PIPELINE TABLE */}
              <Card style={{ padding: "18px 22px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 14 }}>
                  <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "1.5px", color: g("cyn") }}>{"\u26A1"} 自動化パイプライン</span>
                  <span style={{ fontSize: 10, color: g("dim"), fontFamily: fm }}>10 プロセス</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "28px 1fr 72px 1fr", borderBottom: `1px solid ${g("bdr")}`, paddingBottom: 6, marginBottom: 2 }}>
                  {["", "プロセス名", "状態", "詳細"].map((h, i) => (
                    <span key={i} style={{ fontSize: 9, fontWeight: 700, letterSpacing: "1px", color: g("dim"), fontFamily: fm, padding: "0 4px" }}>{h}</span>
                  ))}
                </div>
                {pipes.map((p, i) => (
                  <div key={i} style={{
                    display: "grid", gridTemplateColumns: "28px 1fr 72px 1fr", alignItems: "center",
                    padding: "8px 4px", borderBottom: i < pipes.length - 1 ? `1px solid ${g("bdr")}` : "none",
                  }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: sDot[p.s], display: "inline-block" }} />
                    <span style={{ fontSize: 12, fontWeight: 600 }}>{p.n}</span>
                    <span>
                      <span style={{
                        fontSize: 8, fontWeight: 800, fontFamily: fm, letterSpacing: "1px", padding: "2px 6px", borderRadius: 3,
                        background: p.s === "auto" ? g("priDim") : p.s === "off" ? g("redDim") : g("ambDim"),
                        color: p.s === "auto" ? g("pri") : p.s === "off" ? g("red") : g("amb"),
                      }}>{sLbl[p.s]}</span>
                    </span>
                    <span style={{ fontSize: 11, color: g("mid") }}>{p.d}</span>
                  </div>
                ))}
              </Card>
            </div>

            {/* RIGHT */}
            <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
              {/* BLOCKERS */}
              <Card style={{ padding: "18px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 14 }}>
                  <span style={{ color: g("red"), fontSize: 13 }}>{"\u26A0"}</span>
                  <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "1.5px" }}>クリティカルパス・ブロッカー</span>
                </div>
                {blockers.map((b, i) => (
                  <div key={i} style={{
                    background: g(sevC[b.s] + "Dim"), border: `1px solid ${g("bdr")}`, borderRadius: 9,
                    padding: "11px 13px", marginBottom: i < blockers.length - 1 ? 8 : 0,
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
                      <span style={{ fontSize: 12, fontWeight: 700 }}>{b.t}</span>
                      <span style={{ fontSize: 9, fontWeight: 800, fontFamily: fm, padding: "2px 8px", borderRadius: 4, color: "#fff", background: g(sevC[b.s]) }}>{b.s}</span>
                    </div>
                    <div style={{ fontSize: 11, color: g("mid") }}>{b.d}</div>
                  </div>
                ))}
              </Card>

              {/* LOG */}
              <Card style={{ padding: "18px" }}>
                <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "1.5px", color: g("mid"), marginBottom: 14 }}>コマンドログ</div>
                {logs.map((l, i) => (
                  <div key={i} style={{ display: "flex", gap: 10, marginBottom: i < logs.length - 1 ? 14 : 0 }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: g(l.clr), marginTop: 5, flexShrink: 0 }} />
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 1 }}>{l.ti}</div>
                      <div style={{ fontSize: 11, color: g("mid"), marginBottom: 2 }}>{l.ds}</div>
                      <div style={{ fontSize: 10, color: g("dim"), fontFamily: fm }}>{l.tm}</div>
                    </div>
                  </div>
                ))}
              </Card>

              {/* PROJECTS */}
              <Card style={{ padding: "18px" }}>
                <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "1.5px", color: g("mid"), marginBottom: 12 }}>プロジェクト一覧</div>
                {projs.map((p, i) => (
                  <div key={i} style={{
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    padding: "9px 0", borderBottom: i < projs.length - 1 ? `1px solid ${g("bdr")}` : "none",
                  }}>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 1 }}>{p.n}</div>
                      <div style={{ fontSize: 10, color: g("dim"), fontFamily: fm }}>{p.st}</div>
                    </div>
                    <span style={{
                      fontSize: 9, fontWeight: 700, fontFamily: fm, padding: "2px 8px", borderRadius: 4,
                      color: g(p.c), background: g(p.c === "dim" ? "bdr" : p.c + "Dim"),
                    }}>{p.tg}</span>
                  </div>
                ))}
              </Card>
            </div>
          </div>
          </>)}

          {/* ═══ TAB 1: 戦略 ═══ */}
          {activeNav === 1 && (<>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 18 }}>
            {/* LEFT: Phase Accordion */}
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "1.5px", color: g("pur"), marginBottom: 4 }}>📐 ロードマップ・フェーズ詳細</div>
              {phaseDetails.map((ph, i) => {
                const isOpen = expandedPhase === i;
                return (
                  <Card key={ph.id} style={{ overflow: "hidden" }}>
                    <button onClick={() => setExpandedPhase(isOpen ? null : i)} style={{
                      width: "100%", background: "none", border: "none", cursor: "pointer",
                      padding: "14px 18px", display: "flex", justifyContent: "space-between", alignItems: "center",
                      fontFamily: ff, color: g("txt"), textAlign: "left",
                    }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ fontSize: 13, fontWeight: 700 }}>{ph.name}</span>
                        <span style={{
                          fontSize: 9, fontWeight: 800, fontFamily: fm, padding: "2px 8px", borderRadius: 4,
                          color: g(ph.clr), background: g(ph.clr + "Dim"),
                        }}>{ph.pct}%</span>
                      </div>
                      <span style={{ fontSize: 12, color: g("dim"), transform: isOpen ? "rotate(180deg)" : "rotate(0)", transition: "transform 0.2s" }}>▼</span>
                    </button>
                    {isOpen && (
                      <div style={{ padding: "0 18px 16px", borderTop: `1px solid ${g("bdr")}` }}>
                        <div style={{ fontSize: 11, color: g("mid"), margin: "12px 0 14px", padding: "8px 12px", background: g("priDim"), borderRadius: 6 }}>
                          🎯 ゴール: {ph.goal}
                        </div>
                        {/* Done */}
                        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "1px", color: g("pri"), marginBottom: 8 }}>✅ 完了済み ({ph.done.length})</div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>
                          {ph.done.map((d, di) => (
                            <span key={di} style={{
                              fontSize: 10, padding: "3px 10px", borderRadius: 5, fontWeight: 600,
                              background: g("priDim"), color: g("pri"), border: `1px solid ${g("bdr")}`,
                            }}>{d}</span>
                          ))}
                        </div>
                        {/* Remaining */}
                        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "1px", color: g("amb"), marginBottom: 8 }}>⏳ 残タスク ({ph.remaining.length})</div>
                        {ph.remaining.map((r, ri) => (
                          <div key={ri} style={{
                            display: "grid", gridTemplateColumns: "48px 1fr 1fr", alignItems: "center",
                            padding: "8px 10px", marginBottom: ri < ph.remaining.length - 1 ? 4 : 0,
                            background: g(priClr[r.priority] + "Dim"), borderRadius: 6, border: `1px solid ${g("bdr")}`,
                          }}>
                            <span style={{ fontSize: 9, fontWeight: 800, fontFamily: fm, color: g(priClr[r.priority]) }}>{r.priority}</span>
                            <span style={{ fontSize: 11, fontWeight: 600 }}>{r.task}</span>
                            <span style={{ fontSize: 10, color: g("mid") }}>{r.blocker}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>

            {/* RIGHT: Ando Principles */}
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <Card style={{ padding: "18px" }}>
                <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "1.5px", color: g("amb"), marginBottom: 16 }}>📖 安藤式7原則</div>
                {andoPrinciples.map((ap, i) => (
                  <div key={ap.num} style={{
                    padding: "12px 14px", marginBottom: i < andoPrinciples.length - 1 ? 8 : 0,
                    background: g("cardAlt"), borderRadius: 8, border: `1px solid ${g("bdr")}`,
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span style={{
                        width: 22, height: 22, borderRadius: 6, fontSize: 10, fontWeight: 800, fontFamily: fm,
                        background: g("ambDim"), color: g("amb"),
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}>{ap.num}</span>
                      <span style={{ fontSize: 12, fontWeight: 700 }}>{ap.title}</span>
                    </div>
                    <div style={{ fontSize: 11, color: g("mid"), paddingLeft: 30 }}>{ap.desc}</div>
                  </div>
                ))}
              </Card>
            </div>
          </div>
          </>)}

          {/* ═══ TAB 2: オペレーション ═══ */}
          {activeNav === 2 && (<>
          {/* System Status Cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 22 }}>
            {sysStatus.map((ss, i) => (
              <Card key={i} style={{ padding: "14px 16px", display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{
                  width: 36, height: 36, borderRadius: 8,
                  background: ss.ok ? g("priDim") : g("redDim"),
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 14, color: ss.ok ? g("pri") : g("red"),
                }}>{ss.ok ? "✓" : "✗"}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 2 }}>{ss.n}</div>
                  <div style={{ fontSize: 10, color: g("mid"), display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 5, height: 5, borderRadius: "50%", background: ss.ok ? g("pri") : g("red"), display: "inline-block" }} />
                    {ss.st} · {ss.dt}
                  </div>
                </div>
              </Card>
            ))}
          </div>

          {/* Full-width Pipeline Table */}
          <Card style={{ padding: "18px 22px", marginBottom: 22 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 14 }}>
              <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "1.5px", color: g("cyn") }}>⚡ パイプライン詳細マトリクス</span>
              <span style={{ fontSize: 10, color: g("dim"), fontFamily: fm }}>{pipeDetails.length} プロセス</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "28px 1fr 72px 1fr 1fr 1fr", borderBottom: `1px solid ${g("bdr")}`, paddingBottom: 6, marginBottom: 2 }}>
              {["", "プロセス名", "状態", "入力元", "出力先", "備考"].map((h, i) => (
                <span key={i} style={{ fontSize: 9, fontWeight: 700, letterSpacing: "1px", color: g("dim"), fontFamily: fm, padding: "0 4px" }}>{h}</span>
              ))}
            </div>
            {pipeDetails.map((p, i) => (
              <div key={i} style={{
                display: "grid", gridTemplateColumns: "28px 1fr 72px 1fr 1fr 1fr", alignItems: "center",
                padding: "8px 4px", borderBottom: i < pipeDetails.length - 1 ? `1px solid ${g("bdr")}` : "none",
              }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: sDot[p.s], display: "inline-block" }} />
                <span style={{ fontSize: 12, fontWeight: 600 }}>{p.n}</span>
                <span>
                  <span style={{
                    fontSize: 8, fontWeight: 800, fontFamily: fm, letterSpacing: "1px", padding: "2px 6px", borderRadius: 3,
                    background: p.s === "auto" ? g("priDim") : p.s === "off" ? g("redDim") : g("ambDim"),
                    color: p.s === "auto" ? g("pri") : p.s === "off" ? g("red") : g("amb"),
                  }}>{sLbl[p.s]}</span>
                </span>
                <span style={{ fontSize: 11, color: g("mid") }}>{p.from}</span>
                <span style={{ fontSize: 11, color: g("mid") }}>{p.to}</span>
                <span style={{ fontSize: 11, color: g("mid") }}>{p.d}</span>
              </div>
            ))}
          </Card>

          {/* Automation Targets */}
          <Card style={{ padding: "18px 22px" }}>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "1.5px", color: g("amb"), marginBottom: 14 }}>🎯 自動化ターゲット</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
              {[
                { label: "自動", count: pipeDetails.filter(p => p.s === "auto").length, total: pipeDetails.length, clr: "pri" },
                { label: "半自動", count: pipeDetails.filter(p => p.s === "semi").length, total: pipeDetails.length, clr: "amb" },
                { label: "手動/未設定", count: pipeDetails.filter(p => p.s === "manual" || p.s === "off").length, total: pipeDetails.length, clr: "red" },
              ].map((a, i) => (
                <div key={i} style={{ background: g(a.clr + "Dim"), borderRadius: 8, padding: "14px 16px", border: `1px solid ${g("bdr")}` }}>
                  <div style={{ fontSize: 24, fontWeight: 800, color: g(a.clr), marginBottom: 4 }}>{a.count}</div>
                  <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 6 }}>{a.label}</div>
                  <div style={{ height: 4, background: g("bdr"), borderRadius: 2, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${Math.round(a.count / a.total * 100)}%`, background: g(a.clr), borderRadius: 2 }} />
                  </div>
                  <div style={{ fontSize: 10, color: g("dim"), fontFamily: fm, marginTop: 4 }}>{a.count}/{a.total} プロセス</div>
                </div>
              ))}
            </div>
          </Card>

          {/* P0-4: データメンテナンス */}
          <Card style={{ padding: "18px 22px", marginTop: 22 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "1.5px", color: g("red") }}>🗑️ データメンテナンス</span>
            </div>

            <div style={{
              background: g("cardAlt"), borderRadius: 8, padding: "14px 16px", border: `1px solid ${g("bdr")}`,
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>テストDMデータ削除</div>
                  <div style={{ fontSize: 11, color: g("mid"), lineHeight: 1.5 }}>
                    campaign に &quot;test&quot; または &quot;bulk&quot; を含む dm_send_log レコードを削除します。
                    <br />対象: bulk_*, pipe3_bulk_*, 20250217_test_* 等
                  </div>
                </div>
                <button
                  onClick={handleCountTestData}
                  disabled={testDataLoading}
                  style={{
                    background: g("cynDim"), color: g("cyn"), border: `1px solid ${g("bdr")}`,
                    borderRadius: 6, padding: "6px 14px", fontSize: 11, fontWeight: 700,
                    cursor: testDataLoading ? "not-allowed" : "pointer", fontFamily: ff,
                    opacity: testDataLoading ? 0.5 : 1, whiteSpace: "nowrap",
                  }}
                >
                  {testDataLoading ? "確認中..." : "件数チェック"}
                </button>
              </div>

              {/* 件数表示 */}
              {testDataCount && (
                <div style={{
                  background: g("redDim"), borderRadius: 6, padding: "12px 14px",
                  border: `1px solid ${g("bdr")}`, marginBottom: 10,
                }}>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 10 }}>
                    <div>
                      <div style={{ fontSize: 9, fontWeight: 700, color: g("dim"), letterSpacing: "0.5px", marginBottom: 2 }}>test系</div>
                      <div style={{ fontSize: 18, fontWeight: 800, fontFamily: fm, color: g("red") }}>{testDataCount.test_count.toLocaleString()}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 9, fontWeight: 700, color: g("dim"), letterSpacing: "0.5px", marginBottom: 2 }}>bulk系</div>
                      <div style={{ fontSize: 18, fontWeight: 800, fontFamily: fm, color: g("amb") }}>{testDataCount.bulk_count.toLocaleString()}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 9, fontWeight: 700, color: g("dim"), letterSpacing: "0.5px", marginBottom: 2 }}>合計</div>
                      <div style={{ fontSize: 18, fontWeight: 800, fontFamily: fm, color: g("red") }}>{testDataCount.total.toLocaleString()}</div>
                    </div>
                  </div>

                  {testDataCount.total > 0 && !testDataConfirm && (
                    <button
                      onClick={() => setTestDataConfirm(true)}
                      style={{
                        background: g("red"), color: "#fff", border: "none",
                        borderRadius: 6, padding: "8px 18px", fontSize: 12, fontWeight: 700,
                        cursor: "pointer", fontFamily: ff, width: "100%",
                      }}
                    >
                      {testDataCount.total.toLocaleString()}件を削除
                    </button>
                  )}

                  {/* 確認ダイアログ */}
                  {testDataConfirm && (
                    <div style={{
                      background: g("card"), borderRadius: 8, padding: "14px",
                      border: `2px solid ${g("red")}`,
                    }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: g("red"), marginBottom: 8, textAlign: "center" }}>
                        本当に {testDataCount.total.toLocaleString()} 件を削除しますか？
                      </div>
                      <div style={{ fontSize: 11, color: g("mid"), marginBottom: 12, textAlign: "center" }}>
                        この操作は取り消せません
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          onClick={() => setTestDataConfirm(false)}
                          style={{
                            flex: 1, background: g("bdr"), color: g("txt"), border: "none",
                            borderRadius: 6, padding: "8px", fontSize: 12, fontWeight: 600,
                            cursor: "pointer", fontFamily: ff,
                          }}
                        >
                          キャンセル
                        </button>
                        <button
                          onClick={handleDeleteTestData}
                          disabled={testDataDeleting}
                          style={{
                            flex: 1, background: g("red"), color: "#fff", border: "none",
                            borderRadius: 6, padding: "8px", fontSize: 12, fontWeight: 700,
                            cursor: testDataDeleting ? "not-allowed" : "pointer", fontFamily: ff,
                            opacity: testDataDeleting ? 0.5 : 1,
                          }}
                        >
                          {testDataDeleting ? "削除中..." : "削除実行"}
                        </button>
                      </div>
                    </div>
                  )}

                  {testDataCount.total === 0 && (
                    <div style={{ fontSize: 11, color: g("pri"), fontWeight: 600, textAlign: "center" }}>
                      テストデータはありません
                    </div>
                  )}
                </div>
              )}

              {/* 結果メッセージ */}
              {testDataResult && (
                <div style={{
                  fontSize: 11, fontWeight: 600, padding: "8px 12px", borderRadius: 6,
                  background: testDataResult.startsWith('エラー') || testDataResult.startsWith('削除エラー')
                    ? g("redDim") : g("priDim"),
                  color: testDataResult.startsWith('エラー') || testDataResult.startsWith('削除エラー')
                    ? g("red") : g("pri"),
                }}>
                  {testDataResult}
                </div>
              )}
            </div>
          </Card>
          </>)}

          {/* ═══ TAB 3: アセット ═══ */}
          {activeNav === 3 && (<>
          {/* Project Detail Cards */}
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "1.5px", color: g("pur"), marginBottom: 14 }}>🏗️ プロジェクト詳細</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 14, marginBottom: 22 }}>
            {projectDetails.map((p, i) => (
              <Card key={i} style={{ padding: "18px 20px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 20 }}>{p.icon}</span>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 700 }}>{p.n}</div>
                      <div style={{ fontSize: 11, color: g("mid") }}>{p.desc}</div>
                    </div>
                  </div>
                  <span style={{
                    fontSize: 9, fontWeight: 700, fontFamily: fm, padding: "2px 8px", borderRadius: 4,
                    color: g(p.c), background: g(p.c === "dim" ? "bdr" : p.c + "Dim"),
                  }}>{p.tg}</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8, marginTop: 12 }}>
                  {p.stats.map((s, si) => (
                    <div key={si} style={{ background: g("cardAlt"), borderRadius: 6, padding: "8px 10px", border: `1px solid ${g("bdr")}` }}>
                      <div style={{ fontSize: 9, fontWeight: 700, color: g("dim"), letterSpacing: "0.5px", marginBottom: 2 }}>{s.label}</div>
                      <div style={{ fontSize: 12, fontWeight: 700, fontFamily: fm }}>{s.val}</div>
                    </div>
                  ))}
                </div>
                {p.url && (
                  <div style={{ fontSize: 10, color: g("cyn"), fontFamily: fm, marginTop: 10 }}>🔗 {p.url}</div>
                )}
              </Card>
            ))}
          </div>

          {/* Tech Stack Grid */}
          <Card style={{ padding: "18px 22px" }}>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "1.5px", color: g("cyn"), marginBottom: 14 }}>🔧 技術スタック</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
              {techStack.map((ts, i) => (
                <div key={i} style={{ background: g("cardAlt"), borderRadius: 8, padding: "12px 14px", border: `1px solid ${g("bdr")}` }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: g("cyn"), letterSpacing: "0.5px", marginBottom: 6 }}>{ts.cat}</div>
                  <div style={{ fontSize: 11, color: g("mid"), lineHeight: 1.5 }}>{ts.items}</div>
                </div>
              ))}
            </div>
          </Card>
          </>)}

        </main>
      </div>

      {/* STATUS BAR */}
      <footer style={{
        height: 38, background: g("bar"), borderTop: `1px solid ${g("barBdr")}`,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0 22px", fontSize: 10, color: g("dim"), fontFamily: fm, flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: g("pri") }} />
            OS稼働率: 99.9%
          </span>
          <span>|</span><span>遅延: 12ms</span><span>|</span><span>負荷: 0.42</span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={{
            background: g("pri"), color: "#fff", border: "none", borderRadius: 5,
            padding: "4px 12px", fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: ff,
          }}>{"\u2295"} 新規コマンド</button>
          <button style={{
            background: "transparent", color: g("mid"), border: `1px solid ${g("bdr")}`,
            borderRadius: 5, padding: "4px 12px", fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: ff,
          }}>データ書出</button>
        </div>
      </footer>
    </div>
  );
}
