// ============================================================
// モックレスポンス生成器
// OPENAI_API_KEY 未設定時に使用。キー到着後は callOpenAI() に切り替わる。
// ============================================================
import type { DmGenerateResponse } from '@/types';

// セグメント別モックDM（tone付き）
interface MockDmEntry {
  message: string;
  reasoning: string;
  tone: 'emotional' | 'factual' | 'playful';
  byaf: string;
}

const MOCK_DM_BY_SEGMENT: Record<string, MockDmEntry[]> = {
  'S1': [
    { message: '{name}さん💎 いつも本当にありがとう！{name}さんがいてくれるから頑張れるんだ😊', tone: 'emotional', byaf: '無理しないでね！', reasoning: 'S1:VIP現役。特別感を最大限に。感謝+存在承認+BYAF。' },
    { message: '{name}さん✨ この前の配信すっごく楽しかった！{name}さんのおかげだよ💕', tone: 'playful', byaf: '気が向いたらまた来てね！', reasoning: 'S1:VIP現役。直近配信への言及+感謝+BYAF。' },
  ],
  'S2': [
    { message: '{name}さん💕 最近会えて嬉しかった！また一緒に楽しい時間過ごしたいな😊', tone: 'emotional', byaf: 'もちろん{name}さんのペースでね！', reasoning: 'S2:VIP準現役。再来訪の軽い誘い+BYAF。' },
  ],
  'S3': [
    { message: '{name}さん😊 ふと{name}さんのこと思い出して！元気にしてるかな？', tone: 'emotional', byaf: '気が向いたら遊びに来てね💕', reasoning: 'S3:VIP休眠。懐かしさ+軽い誘い+BYAF。押しすぎない。' },
  ],
  'S4': [
    { message: '{name}さん！ いつも来てくれてありがとう😊 {name}さんがいると安心する！', tone: 'emotional', byaf: 'また待ってるね💕', reasoning: 'S4:常連現役。居場所感+安心感+BYAF。' },
  ],
  'S5': [
    { message: '{name}さん、最近どうしてる？😊 ちょっと会えてなくて寂しいな〜', tone: 'emotional', byaf: '無理しないでね！', reasoning: 'S5:常連離脱危機。寂しさ表現+BYAF。圧をかけない。' },
  ],
  'S6': [
    { message: '{name}さん！ 久しぶり〜😊 元気かな？たまには顔見せてくれると嬉しいな💕', tone: 'playful', byaf: 'もちろん気が向いたらでいいよ！', reasoning: 'S6:常連休眠。久しぶり感+軽い誘い+BYAF。' },
  ],
  'S7': [
    { message: '{name}さん✨ この前話してくれたの覚えてるよ！また続き聞かせてね😊', tone: 'factual', byaf: '気が向いたらでいいからね！', reasoning: 'S7:中堅現役。個別感+会話の継続+BYAF。' },
  ],
  'S8': [
    { message: '{name}さん！ 元気にしてる？😊', tone: 'playful', byaf: '気が向いたら遊びに来てね〜！', reasoning: 'S8:中堅休眠。軽く短く+BYAF。' },
  ],
  'S9': [
    { message: '{name}さん、来てくれてありがとう😊', tone: 'playful', byaf: 'また気軽に遊びに来てね！', reasoning: 'S9:ライト。シンプル+軽い+BYAF。' },
  ],
  'S10': [
    { message: '{name}さん！ 見に来てくれてありがとう✨', tone: 'playful', byaf: 'よかったらまた来てね😊', reasoning: 'S10:単発。最小限+感謝+BYAF。' },
  ],
};

// シナリオコード → シナリオキー変換
const SCENARIO_CODE_MAP: Record<string, string> = {
  'A': 'thankyou_regular',
  'B': 'churn_recovery',
  'C': 'pre_broadcast',
  'D': 'vip_special',
  'E': 'return_nudge',
};

const MOCK_DM_BY_SCENARIO: Record<string, MockDmEntry> = {
  'thankyou_regular': { message: '{name}さん💕 今日は来てくれてありがとう！すっごく楽しかった😊', tone: 'emotional', byaf: 'また気が向いたら来てね！', reasoning: 'お礼DM。感謝+感情+BYAF。' },
  'churn_recovery': { message: '{name}さん😊 最近会えてないね〜 元気にしてる？ふと思い出しちゃった！', tone: 'emotional', byaf: '無理しないでね💕', reasoning: '離脱回復。懐かしさ+気遣い+BYAF。圧をかけない。' },
  'pre_broadcast': { message: '{name}さん✨ 今日配信するよ〜！{name}さんに会えたら嬉しいな💕', tone: 'playful', byaf: 'もちろん無理しないでね！', reasoning: '配信前告知。期待感+個別感+BYAF。' },
  'vip_special': { message: '{name}さん💎 いつも本当にありがとう！{name}さんは特別な存在だよ✨', tone: 'emotional', byaf: 'これからもよろしくね！', reasoning: 'VIP特別DM。特別感最大+感謝+承認。' },
  'return_nudge': { message: '{name}さん😊 久しぶり〜！元気にしてた？また会えたら嬉しいな✨', tone: 'playful', byaf: 'もちろん無理しないでね！', reasoning: '復帰促進。懐かしさ+軽さ+BYAF。' },
};

/**
 * mode=customer + dm_generate のモックレスポンス生成
 * DmGenerateResponse 型に完全準拠
 */
export function generateMockDmResponse(params: {
  username: string;
  segment?: string;
  scenario?: string;
  castDisplayName?: string;
}): DmGenerateResponse {
  const { username, segment, scenario, castDisplayName } = params;

  // シナリオ指定があればシナリオ優先（コード A-E → フルキー変換）
  let mock: MockDmEntry | undefined;
  if (scenario) {
    const scenarioKey = SCENARIO_CODE_MAP[scenario] || scenario;
    mock = MOCK_DM_BY_SCENARIO[scenarioKey];
  }

  // セグメント指定で選択
  if (!mock && segment) {
    const segKey = segment.toUpperCase().replace(/[^S0-9]/g, '').replace(/^(S\d+).*/, '$1');
    const candidates = MOCK_DM_BY_SEGMENT[segKey] || MOCK_DM_BY_SEGMENT['S9'];
    mock = candidates[Math.floor(Math.random() * candidates.length)];
  }

  // デフォルト
  if (!mock) {
    mock = MOCK_DM_BY_SCENARIO['thankyou_regular'];
  }

  const message = mock.message.replace(/\{name\}/g, username) + ' ' + mock.byaf.replace(/\{name\}/g, username);

  return {
    message,
    reasoning: `[MOCK] ${mock.reasoning}`,
    tone: mock.tone,
    byaf_used: mock.byaf.replace(/\{name\}/g, username),
    persona_used: castDisplayName || 'default',
    persona_found: !!castDisplayName,
    is_mock: true,
    model: 'mock',
    cost_tokens: 0,
    cost_usd: 0,
  };
}

/** 既存 PersonaApiResponse 形式のモック（mode=ai フォールバック用） */
export interface MockPersonaResponse {
  output: { message: string; reasoning: string };
  raw_text: string;
  reasoning: string;
  cost_tokens: number;
  cost_usd: number;
  persona_used: string;
  persona_found: boolean;
  is_mock: true;
}

export function generateGenericMockResponse(taskType: string, castDisplayName?: string): MockPersonaResponse {
  const output = {
    message: `[MOCK] ${taskType} のモックレスポンスです。APIキー設定後に実レスポンスに切り替わります。`,
    reasoning: `[MOCK] ${taskType} — APIキー未設定のためモックを返却。`,
  };

  return {
    output,
    raw_text: JSON.stringify(output),
    reasoning: output.reasoning,
    cost_tokens: 0,
    cost_usd: 0,
    persona_used: castDisplayName || 'default',
    persona_found: !!castDisplayName,
    is_mock: true,
  };
}
