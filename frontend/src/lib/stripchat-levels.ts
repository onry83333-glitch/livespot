/**
 * Stripchat公式リーグシステムに準拠したユーザー名色マッピング
 *
 * 公式リーグ体系（7段階・100レベル）:
 *   Grey    (Lv.1-9)   → グレー     — 無課金
 *   Bronze  (Lv.10-19) → ブロンズ   — 初回コイン購入(500XP)で到達
 *   Silver  (Lv.20-34) → シルバー
 *   Gold    (Lv.35-54) → ゴールド   — 永久保持
 *   Diamond (Lv.55-79) → 紫(violet) — 永久・マスク機能
 *   Royal   (Lv.80-99) → 赤(red)    — 永久・Ultimate会員無料付与
 *   Legend  (Lv.100)   → 赤(特別星バッジ) — 最上位
 *
 * XP計算: 1コイン消費 = 5XP + 初回購入ボーナス500XP
 */

export function getUserColorFromCoins(totalCoins: number): string {
  const estimatedXP = totalCoins > 0 ? totalCoins * 5 + 500 : 0;

  if (estimatedXP >= 5000000) return '#cc0000';   // Legend
  if (estimatedXP >= 600000)  return '#e53935';   // Royal
  if (estimatedXP >= 200000)  return '#9c27b0';   // Diamond
  if (estimatedXP >= 50000)   return '#ffc107';   // Gold
  if (estimatedXP >= 10000)   return '#9e9e9e';   // Silver
  if (estimatedXP >= 500)     return '#e67e22';   // Bronze
  return '#888888';                                // Grey
}

export function getUserColorInfo(totalCoins: number): { color: string; label: string } {
  const estimatedXP = totalCoins > 0 ? totalCoins * 5 + 500 : 0;

  if (estimatedXP >= 5000000) return { color: '#cc0000', label: '⭐ Legend' };
  if (estimatedXP >= 600000)  return { color: '#e53935', label: '🔴 Royal' };
  if (estimatedXP >= 200000)  return { color: '#9c27b0', label: '🟣 Diamond' };
  if (estimatedXP >= 50000)   return { color: '#ffc107', label: '🏅 Gold' };
  if (estimatedXP >= 10000)   return { color: '#9e9e9e', label: '🪙 Silver' };
  if (estimatedXP >= 500)     return { color: '#e67e22', label: '🟠 Bronze' };
  return { color: '#888888', label: '⚪ Grey' };
}
