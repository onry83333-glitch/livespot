import { NextRequest, NextResponse } from 'next/server';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

export async function POST(req: NextRequest) {
  // 1. 認証チェック（Supabase JWT検証）
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 });
  }
  const token = authHeader.slice(7);

  // Supabase auth API でトークン検証
  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!userRes.ok) {
    return NextResponse.json({ error: '認証トークンが無効です' }, { status: 401 });
  }

  // 2. リクエストボディ取得
  const body = await req.json();
  const { prompt, systemPrompt } = body as {
    prompt: string;
    systemPrompt?: string;
  };

  if (!prompt) {
    return NextResponse.json({ error: 'prompt は必須です' }, { status: 400 });
  }

  if (!ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY が未設定です' }, { status: 500 });
  }

  // 3. Claude API 呼び出し
  try {
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system: systemPrompt || 'あなたはライブ配信の分析アシスタントです。配信セッションデータを分析し、日本語でレポートを生成してください。具体的な数値やユーザー名を引用して、実用的で読みやすいレポートを書いてください。',
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!apiRes.ok) {
      const errBody = await apiRes.json().catch(() => ({}));
      if (apiRes.status === 401) {
        return NextResponse.json({ error: 'APIキーが無効です' }, { status: 502 });
      }
      if (apiRes.status === 429) {
        return NextResponse.json({ error: 'レート制限中です。しばらく待ってから再試行してください' }, { status: 429 });
      }
      return NextResponse.json(
        { error: (errBody as Record<string, unknown>).error || `Claude API error: ${apiRes.status}` },
        { status: 502 },
      );
    }

    const apiData = await apiRes.json();
    const text = apiData.content[0].text;
    const inputTokens = apiData.usage?.input_tokens || 0;
    const outputTokens = apiData.usage?.output_tokens || 0;
    const tokensUsed = inputTokens + outputTokens;
    const costUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;

    return NextResponse.json({ text, tokensUsed, costUsd });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
