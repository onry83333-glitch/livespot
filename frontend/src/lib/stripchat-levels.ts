/**
 * Stripchat公式リーグ名をラベルに使いつつ、
 * paid_usersのtotal_coins（自部屋での累計消費額）に基づいて
 * ダーク背景で視認性の高い色を割り当てる。
 *
 * 注意: total_coinsは自部屋の消費のみ。ユーザーの実際のStripchatレベルとは異なる。
 * あくまで「このキャストにとっての重要度」を色で示すもの。
 *
 * Stripchat公式リーグ（参考）:
 *   Grey(1-9) / Bronze(10-19) / Silver(20-34) / Gold(35-54)
 *   Diamond(55-79) / Royal(80-99) / Legend(100)
 *   色: Grey→グレー, Bronze→ブロンズ, Silver→シルバー,
 *       Gold→ゴールド, Diamond→紫, Royal→赤, Legend→赤+星
 */

export function getUserColorFromCoins(totalCoins: number): string {
  if (totalCoins >= 100000) return '#ff1744';   // 鮮やかな赤 — Royal級（10万tk+）
  if (totalCoins >= 50000)  return '#e53935';   // 赤 — Royal級（5万tk+）
  if (totalCoins >= 20000)  return '#d500f9';   // マゼンタ紫 — Diamond上位（2万tk+）
  if (totalCoins >= 10000)  return '#aa00ff';   // 紫 — Diamond（1万tk+）
  if (totalCoins >= 5000)   return '#ffc107';   // ゴールド — Gold（5千tk+）
  if (totalCoins >= 3000)   return '#ffab00';   // 濃いゴールド — Gold下位（3千tk+）
  if (totalCoins >= 1000)   return '#ff9100';   // オレンジ — Silver/Bronze上位（1千tk+）
  if (totalCoins >= 300)    return '#e67e22';   // ブロンズ — Bronze（300tk+）
  if (totalCoins >= 50)     return '#8d6e63';   // 暗めブロンズ — Bronze下位（50tk+）
  return '#78909c';                              // ブルーグレー — Grey（50tk未満）
}

export function getUserColorInfo(totalCoins: number): { color: string; label: string } {
  if (totalCoins >= 100000) return { color: '#ff1744', label: '🔴 Royal+' };
  if (totalCoins >= 50000)  return { color: '#e53935', label: '🔴 Royal' };
  if (totalCoins >= 20000)  return { color: '#d500f9', label: '🟣 Diamond+' };
  if (totalCoins >= 10000)  return { color: '#aa00ff', label: '🟣 Diamond' };
  if (totalCoins >= 5000)   return { color: '#ffc107', label: '🏅 Gold+' };
  if (totalCoins >= 3000)   return { color: '#ffab00', label: '🏅 Gold' };
  if (totalCoins >= 1000)   return { color: '#ff9100', label: '🟠 Silver+' };
  if (totalCoins >= 300)    return { color: '#e67e22', label: '🟠 Bronze' };
  if (totalCoins >= 50)     return { color: '#8d6e63', label: '🟤 Bronze-' };
  return { color: '#78909c', label: '⚪ Grey' };
}
