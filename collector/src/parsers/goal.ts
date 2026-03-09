/**
 * Goal event parser — Centrifugo goalChanged
 *
 * Stripchat goalChanged イベント構造（推定）:
 *   data.goal.amount        — 目標額
 *   data.goal.currentAmount — 現在額
 *   data.goal.text          — ゴール説明テキスト
 *   data.goal.isAchieved    — 達成フラグ
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function str(v: any): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function num(v: any): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

export interface GoalEvent {
  message: string;
  goalAmount: number;
  currentAmount: number;
  isAchieved: boolean;
  goalText: string;
}

/**
 * goalChanged の data オブジェクトをパース。
 * Centrifugo push: { channel: "goalChanged@{modelId}", pub: { data: {...} } }
 */
export function parseCentrifugoGoal(data: unknown): GoalEvent | null {
  if (!data || typeof data !== 'object') return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = data as any;

  // goalChanged の構造はネストあり/なし両方に対応
  const goal = d.goal || d;

  const goalAmount = num(goal.amount) || num(goal.goalAmount) || num(goal.target) || 0;
  const currentAmount = num(goal.currentAmount) || num(goal.current) || num(goal.progress) || 0;
  const isAchieved = goal.isAchieved === true || goal.achieved === true || goal.isCompleted === true;
  const goalText = str(goal.text) || str(goal.description) || str(goal.title) || '';

  // メッセージ生成
  let message: string;
  if (isAchieved) {
    message = `🎯 ゴール達成！ ${goalText} (${currentAmount}/${goalAmount} tokens)`;
  } else {
    message = `🎯 ゴール進捗: ${goalText} (${currentAmount}/${goalAmount} tokens)`;
  }

  return {
    message,
    goalAmount,
    currentAmount,
    isAchieved,
    goalText,
  };
}
