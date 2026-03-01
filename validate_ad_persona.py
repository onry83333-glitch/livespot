#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
北関東OS 広告文ペルソナ検証スクリプト

4広告文 × 3ペルソナ = 12件の検証を実行
検証結果をMarkdown形式で出力
"""

import json
from datetime import datetime

# 広告文データ
AD_COPIES = {
    "ad1_safety": {
        "name": "広告文①: 安心訴求型",
        "title": "北関東で始める安心在宅ワーク｜無料相談実施中",
        "description": "茨城・栃木・群馬で在宅ワークをお探しの方へ。完全サポート＋安全な環境で月収20-50万円も可能。もちろん、まずはお話だけでも大丈夫です。今なら無料相談受付中！",
        "cta": "無料で相談する"
    },
    "ad2_achievement": {
        "name": "広告文②: 実績訴求型",
        "title": "北関東300名以上が活躍中｜在宅で月30万円",
        "description": "茨城・栃木・群馬で既に300名以上が活躍。未経験でもライブ配信のお仕事で月収30万円を実現。完全在宅＋自由なシフト。もちろん、不安な点だけ相談もOKです。無料登録はこちら。",
        "cta": "詳細を見る"
    },
    "ad3_empathy": {
        "name": "広告文③: 共感訴求型",
        "title": "一人でも大丈夫。北関東在宅ワークサポート",
        "description": "「地元で働きたいけど求人が少ない」そんな悩み、よくわかります。茨城・栃木・群馬で完全在宅のライブ配信のお仕事を。専任サポート付き＋収入保証あり。もちろん、まずはお話を聞くだけでもOKです。",
        "cta": "相談してみる"
    },
    "ad4_opportunity": {
        "name": "広告文④: チャンス訴求型",
        "title": "【北関東限定】今だけ登録特典3万円プレゼント",
        "description": "茨城・栃木・群馬在住の方限定！ライブ配信のお仕事で自由に稼ぐ。今なら登録特典3万円＋研修費全額サポート。未経験OK・年齢不問。もちろん、詳しい話だけ聞いてから決めてもOKです。",
        "cta": "特典を受け取る"
    }
}

# ペルソナデータ
PERSONAS = {
    "persona_a_20s": {
        "name": "ペルソナA: 20代単身女性",
        "age": 24,
        "location": "茨城県水戸市",
        "employment": "事務職2年（退職済み）",
        "income": "250万円（前職）",
        "concerns": [
            "地元で良い仕事が見つからない",
            "将来の不安",
            "キャリアが見えない"
        ],
        "values": ["安定", "成長機会", "柔軟な働き方"]
    },
    "persona_b_30s": {
        "name": "ペルソナB: 30代単身女性",
        "age": 32,
        "location": "栃木県宇都宮市",
        "employment": "販売職8年（現職）",
        "income": "280万円",
        "concerns": [
            "給料が上がらない",
            "転職したいが選択肢が少ない",
            "スキルアップの機会がない"
        ],
        "values": ["収入向上", "専門性", "自己実現"]
    },
    "persona_c_40s": {
        "name": "ペルソナC: 40代単身女性",
        "age": 43,
        "location": "群馬県前橋市",
        "employment": "パート・アルバイト歴20年",
        "income": "180万円",
        "concerns": [
            "年齢的に正社員は難しい",
            "経済的に厳しい",
            "将来への不安が大きい"
        ],
        "values": ["経済的安定", "柔軟な時間", "尊厳ある働き方"]
    }
}

# 検証結果テンプレート
def evaluate_ad(ad_key, persona_key):
    """
    広告文をペルソナ視点で評価（手動評価用テンプレート）
    
    実際の評価は以下のいずれかで実施：
    1. /api/personaエンドポイント経由（自動）
    2. YUUTA手動評価
    3. Claude AI分析（シミュレーション）
    """
    ad = AD_COPIES[ad_key]
    persona = PERSONAS[persona_key]
    
    # シミュレーション評価（実際はAPI or 手動評価に置き換え）
    evaluation = {
        "ad_name": ad["name"],
        "persona_name": persona["name"],
        "title": ad["title"],
        "description": ad["description"],
        "cta": ad["cta"],
        "scores": {
            "first_impression": 0,  # 0-10
            "empathy": 0,          # 0-10
            "click_intent": 0,     # 0-10
            "trust": 0,            # 0-10
        },
        "concerns": [],  # ペルソナが感じる不安・懸念
        "positive_points": [],  # 好印象の要素
        "improvement_suggestions": [],  # 改善提案
        "overall_comment": ""
    }
    
    return evaluation

def generate_validation_report():
    """
    全12件（4広告文×3ペルソナ）の検証結果レポート生成
    """
    results = []
    
    for ad_key in AD_COPIES.keys():
        for persona_key in PERSONAS.keys():
            result = evaluate_ad(ad_key, persona_key)
            results.append(result)
    
    # Markdownレポート生成
    report = f"""# 北関東OS 広告文ペルソナ検証結果

**検証日**: {datetime.now().strftime('%Y-%m-%d %H:%M')}  
**検証件数**: {len(results)}件（4広告文 × 3ペルソナ）

---

## 検証サマリー

| 広告文 | ペルソナA（20代） | ペルソナB（30代） | ペルソナC（40代） | 平均スコア |
|--------|------------------|------------------|------------------|-----------|
| 広告文①: 安心訴求型 | ー/40 | ー/40 | ー/40 | ー/40 |
| 広告文②: 実績訴求型 | ー/40 | ー/40 | ー/40 | ー/40 |
| 広告文③: 共感訴求型 | ー/40 | ー/40 | ー/40 | ー/40 |
| 広告文④: チャンス訴求型 | ー/40 | ー/40 | ー/40 | ー/40 |

**スコア内訳**: 第一印象(10) + 共感度(10) + クリック意欲(10) + 信頼性(10) = 合計40点

---

## 詳細評価

"""
    
    # 各評価の詳細を追記（実際の評価データで上書き）
    for i, result in enumerate(results, 1):
        report += f"""
### 評価{i}: {result['ad_name']} × {result['persona_name']}

**広告タイトル**: {result['title']}

**広告説明文**: {result['description']}

**CTAボタン**: {result['cta']}

#### スコア
- 第一印象: ー/10
- 共感度: ー/10
- クリック意欲: ー/10
- 信頼性: ー/10
- **合計**: ー/40

#### ペルソナの視点

**好印象の要素**:
- （評価待ち）

**不安・懸念点**:
- （評価待ち）

**改善提案**:
- （評価待ち）

**総評**:  
（評価待ち）

---

"""
    
    # 最終推奨セクション
    report += """
## 最終推奨

### 🏆 推奨広告文（1位）
**広告文③: 共感訴求型**
- **理由**: （検証後に記入）
- **ターゲット層**: 全年代に高評価（予測）
- **推奨配信**: メイン広告として使用

### 🥈 推奨広告文（2位）
**広告文①: 安心訴求型**
- **理由**: （検証後に記入）
- **ターゲット層**: 20代・30代向け
- **推奨配信**: A/Bテスト候補

### 🥉 推奨広告文（3位）
**広告文②: 実績訴求型**
- **理由**: （検証後に記入）
- **ターゲット層**: 実績重視層
- **推奨配信**: サブ広告として使用

---

## 次のアクション

1. [ ] 各評価の詳細データ入力（手動 or API経由）
2. [ ] スコア集計・ランキング確定
3. [ ] 最終推奨広告文1-2本を選定
4. [ ] Google広告キャンペーン設定
5. [ ] A/Bテスト設計

---

**作成者**: Claude Code  
**ステータス**: 🔧 評価待ち（テンプレート生成完了）
"""
    
    return report

# メイン実行
if __name__ == "__main__":
    # 検証レポート生成
    report = generate_validation_report()
    
    # ファイル出力（北関東OSのreportsディレクトリ）
    output_path = "C:/dev/kitakanto-os/reports/ad-validation-results.md"
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(report)
    
    print(f"[OK] Validation report template created: {output_path}")
    print("\nNext steps:")
    print("1. Manual evaluation: Fill in scores for all 12 evaluations")
    print("2. Or use /api/persona endpoint for automated evaluation")
    print("3. Run analysis to determine final recommended ads")
