/**
 * DM施策エンジン（Step 2c）— LLM不要、JSテンプレート生成
 *
 * collect5AxisDataの生データからDM施策セクションのマークダウンを生成する。
 * ユーザー名リストの抽出・整形のみなのでLLMは不要。
 */

export interface DMData {
  newTipperNames: Array<{ name: string; tk: number; count: number }>;
  highValueNewNames: Array<{ name: string; tk: number }>;
  repeaterNames: Array<{ name: string; tk: number; count: number; firstDate: string; totalTk: number }>;
  returnUserNames: Array<{ name: string; daysSince: number; tk: number }>;
  secondVisitRate: { rate: string; noSecondVisitUsers: Array<{ name: string }> };
  returnTriggers: Array<{ name: string; trigger: string; daysSince: number; tk: number }>;
  priorityA: Array<{ name: string; reason: string }>;
  priorityB: Array<{ name: string; reason: string }>;
  priorityC: Array<{ name: string; reason: string }>;
}

/** matchAll互換ヘルパー（downlevelIteration不要） */
function matchAllArray(text: string, regex: RegExp): RegExpExecArray[] {
  const results: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  while ((m = re.exec(text)) !== null) results.push(m);
  return results;
}

/**
 * FiveAxisDataの文字列からDMData構造を抽出する
 */
export function extractDMData(fiveAxisRaw: {
  tipperStructure: string;
  dmActionLists: string;
  userBehavior: string;
}): DMData {
  const result: DMData = {
    newTipperNames: [],
    highValueNewNames: [],
    repeaterNames: [],
    returnUserNames: [],
    secondVisitRate: { rate: 'N/A', noSecondVisitUsers: [] },
    returnTriggers: [],
    priorityA: [],
    priorityB: [],
    priorityC: [],
  };

  // --- tipperStructure から新規・リピーター・高額新規を抽出 ---
  const ts = fiveAxisRaw.tipperStructure || '';

  // 新規チッパー
  const newSection = ts.match(/## 新規チッパー[\s\S]*?(?=##|$)/);
  if (newSection) {
    for (const m of matchAllArray(newSection[0], /- ([^\s:]+)[\s:]+(\d+)\s*tk\s*\((\d+)回\)/g)) {
      result.newTipperNames.push({ name: m[1], tk: parseInt(m[2]), count: parseInt(m[3]) });
    }
  }

  // 高額新規
  const highSection = ts.match(/## 高額新規[\s\S]*?(?=##|$)/);
  if (highSection) {
    for (const m of matchAllArray(highSection[0], /- ([^\s:]+)[\s:]+(\d+)\s*tk/g)) {
      result.highValueNewNames.push({ name: m[1], tk: parseInt(m[2]) });
    }
  }

  // リピーター
  const repSection = ts.match(/## リピーター[\s\S]*?(?=##|$)/);
  if (repSection) {
    for (const m of matchAllArray(repSection[0], /- ([^\s:]+)[\s:]+(\d+)\s*tk\s*\((\d+)回\).*?初回[：:]?\s*(\S+).*?累計[：:]?\s*(\d+)\s*tk/g)) {
      result.repeaterNames.push({ name: m[1], tk: parseInt(m[2]), count: parseInt(m[3]), firstDate: m[4], totalTk: parseInt(m[5]) });
    }
  }

  // 復帰ユーザー
  const retSection = ts.match(/## 復帰ユーザー[\s\S]*?(?=##|$)/);
  if (retSection) {
    for (const m of matchAllArray(retSection[0], /- ([^\s:]+)[\s:]+.*?空白\s*(\d+)\s*日.*?(\d+)\s*tk/g)) {
      result.returnUserNames.push({ name: m[1], daysSince: parseInt(m[2]), tk: parseInt(m[3]) });
    }
  }

  // DM優先度
  const priorityASection = ts.match(/🔴 優先度A[\s\S]*?(?=🟡|🟢|##|$)/);
  if (priorityASection) {
    for (const m of matchAllArray(priorityASection[0], /- ([^\s:]+)[\s:]*(.+)/g)) {
      result.priorityA.push({ name: m[1], reason: m[2].trim() });
    }
  }
  const priorityBSection = ts.match(/🟡 優先度B[\s\S]*?(?=🟢|##|$)/);
  if (priorityBSection) {
    for (const m of matchAllArray(priorityBSection[0], /- ([^\s:]+)[\s:]*(.+)/g)) {
      result.priorityB.push({ name: m[1], reason: m[2].trim() });
    }
  }
  const priorityCSection = ts.match(/🟢 優先度C[\s\S]*?(?=##|$)/);
  if (priorityCSection) {
    for (const m of matchAllArray(priorityCSection[0], /- ([^\s:]+)[\s:]*(.+)/g)) {
      result.priorityC.push({ name: m[1], reason: m[2].trim() });
    }
  }

  // --- dmActionLists から離脱予兆・再訪率・復帰きっかけを抽出 ---
  const dm = fiveAxisRaw.dmActionLists || '';

  // #12 初回課金後2回目来訪率
  const secondVisitSection = dm.match(/## #12 初回課金後2回目来訪率[\s\S]*?(?=## #13|$)/);
  if (secondVisitSection) {
    const rateMatch = secondVisitSection[0].match(/来訪率[：:]\s*([^\n]+)/);
    result.secondVisitRate.rate = rateMatch ? rateMatch[1].trim() : 'N/A';
    for (const m of matchAllArray(secondVisitSection[0], /- ([^\s:]+)/g)) {
      if (!m[1].startsWith('#') && !m[1].startsWith('[')) {
        result.secondVisitRate.noSecondVisitUsers.push({ name: m[1] });
      }
    }
  }

  // #13 復帰きっかけ
  const triggerSection = dm.match(/## #13 復帰ユーザーの復帰きっかけ[\s\S]*?(?=##|$)/);
  if (triggerSection) {
    for (const m of matchAllArray(triggerSection[0], /- ([^\s:]+)[\s:]+.*?空白\s*(\d+)\s*日.*?(\d+)\s*tk.*?([^\n]*)/g)) {
      const trigger = m[4]?.includes('ticketshow') ? 'ticketshow' : m[4]?.includes('tip') ? 'tip' : 'other';
      result.returnTriggers.push({ name: m[1], daysSince: parseInt(m[2]), tk: parseInt(m[3]), trigger });
    }
  }

  return result;
}

/**
 * DMDataからマークダウンレポートを生成する（LLM不要）
 */
export function generateDMReport(dmData: DMData): string {
  const sections: string[] = [];

  sections.push('# 📩 DM施策アクションリスト');
  sections.push('> このセクションはデータから自動生成されたリストです（AI分析なし）。コピペしてDM送信にご利用ください。');

  // DM優先度別リスト
  if (dmData.priorityA.length > 0) {
    sections.push('\n## 🔴 優先度A — 即DM推奨');
    for (const u of dmData.priorityA) {
      sections.push(`- **${u.name}** — ${u.reason}`);
    }
  }

  if (dmData.priorityB.length > 0) {
    sections.push('\n## 🟡 優先度B');
    for (const u of dmData.priorityB) {
      sections.push(`- **${u.name}** — ${u.reason}`);
    }
  }

  if (dmData.priorityC.length > 0) {
    sections.push('\n## 🟢 優先度C');
    for (const u of dmData.priorityC) {
      sections.push(`- **${u.name}** — ${u.reason}`);
    }
  }

  // 新規チッパーリスト
  if (dmData.newTipperNames.length > 0) {
    sections.push('\n## 🆕 新規チッパー');
    for (const u of dmData.newTipperNames) {
      sections.push(`- ${u.name}: ${u.tk}tk (${u.count}回)`);
    }
    sections.push('\n> 💡 「初回ありがとう」系DM推奨');
  }

  // リピーター
  if (dmData.repeaterNames.length > 0) {
    sections.push('\n## 🔄 リピーター');
    for (const u of dmData.repeaterNames) {
      sections.push(`- ${u.name}: ${u.tk}tk (${u.count}回) 初回:${u.firstDate} 累計:${u.totalTk}tk`);
    }
  }

  // 復帰ユーザー
  if (dmData.returnUserNames.length > 0) {
    sections.push('\n## 🔙 復帰ユーザー');
    for (const u of dmData.returnUserNames) {
      sections.push(`- ${u.name}: 空白${u.daysSince}日 → ${u.tk}tk`);
    }
    sections.push('\n> 💡 「おかえり」系DM推奨');
  }

  // 復帰きっかけ
  if (dmData.returnTriggers.length > 0) {
    sections.push('\n## 💡 復帰きっかけ分析');
    for (const u of dmData.returnTriggers) {
      sections.push(`- ${u.name}: 空白${u.daysSince}日 → ${u.tk}tk（きっかけ: ${u.trigger}）`);
    }
    sections.push('\n> ticketshow告知をDM文面に含めると復帰率UP');
  }

  // 初回課金後2回目来訪率
  sections.push(`\n## 📊 初回課金後2回目来訪率`);
  sections.push(`来訪率: ${dmData.secondVisitRate.rate}`);
  if (dmData.secondVisitRate.noSecondVisitUsers.length > 0) {
    sections.push(`\n未再訪ユーザー（${dmData.secondVisitRate.noSecondVisitUsers.length}人）:`);
    // コピペ用コードブロック
    const names = dmData.secondVisitRate.noSecondVisitUsers.map(u => u.name);
    sections.push('```');
    sections.push(names.join('\n'));
    sections.push('```');
  }

  // DM用ユーザー名リスト（コピペ用）
  sections.push('\n## 📋 DM用ユーザー名リスト');

  const addCopyBlock = (label: string, names: string[]) => {
    if (names.length === 0) return;
    sections.push(`\n### ${label}（${names.length}人）`);
    sections.push('```');
    sections.push(names.join('\n'));
    sections.push('```');
  };

  addCopyBlock('🔴 優先度A', dmData.priorityA.map(u => u.name));
  addCopyBlock('🟡 優先度B', dmData.priorityB.map(u => u.name));
  addCopyBlock('🟢 優先度C', dmData.priorityC.map(u => u.name));
  addCopyBlock('🆕 新規チッパー', dmData.newTipperNames.map(u => u.name));
  addCopyBlock('🔄 リピーター', dmData.repeaterNames.map(u => u.name));
  addCopyBlock('🔙 復帰ユーザー', dmData.returnUserNames.map(u => u.name));

  return sections.join('\n');
}
