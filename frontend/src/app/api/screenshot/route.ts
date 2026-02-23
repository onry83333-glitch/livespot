// ============================================================
// GET  /api/screenshot?model_id=xxx — CDN画像プロキシ（CORS対策・認証不要）
// POST /api/screenshot — サムネイル取得 + DB保存（認証必須）
//
// Stripchat CDN URL:
//   https://img.strpst.com/thumbs/{unix_ts}/{modelId}_webp
//   認証不要。配信中は30秒〜1分で更新。非配信時も最新画像が返る。
//
// 必要な環境変数:
//   SUPABASE_SERVICE_ROLE_KEY  (POSTのみ)
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { authenticateAndValidateAccount, checkRateLimit } from '@/lib/api-auth';

function buildThumbUrl(modelId: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  return `https://img.strpst.com/thumbs/${timestamp}/${modelId}_webp`;
}

// GET: CDN画像をプロキシ返却
export async function GET(request: NextRequest) {
  const modelId = request.nextUrl.searchParams.get('model_id');
  if (!modelId) {
    return NextResponse.json({ error: 'model_id required' }, { status: 400 });
  }

  const imageUrl = buildThumbUrl(modelId);

  try {
    const res = await fetch(imageUrl);
    if (!res.ok) {
      return NextResponse.json(
        { error: `CDN returned ${res.status}` },
        { status: res.status },
      );
    }

    const imageBuffer = await res.arrayBuffer();
    return new NextResponse(imageBuffer, {
      headers: {
        'Content-Type': 'image/webp',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// POST: サムネイル取得 + cast_screenshots に保存（認証必須）
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { model_id, cast_name, account_id, session_id, thumbnail_type } = body;

  if (!model_id || !cast_name || !account_id) {
    return NextResponse.json({ error: 'model_id, cast_name, account_id required' }, { status: 400 });
  }

  // 認証 + account_id 検証
  const auth = await authenticateAndValidateAccount(request, account_id);
  if (!auth.authenticated) return auth.error;

  // レート制限（同一ユーザー5秒間隔）
  if (!checkRateLimit(`screenshot:${auth.userId}`)) {
    return NextResponse.json({ error: '連続リクエストは5秒間隔で行ってください' }, { status: 429 });
  }

  const imageUrl = buildThumbUrl(model_id);

  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { data, error } = await supabase
    .from('cast_screenshots')
    .insert({
      account_id,
      cast_name,
      model_id,
      session_id: session_id || null,
      image_url: imageUrl,
      thumbnail_type: thumbnail_type || 'manual',
      is_live: true,
      captured_at: new Date().toISOString(),
    })
    .select('id, image_url, captured_at')
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, screenshot: data, image_url: imageUrl });
}
