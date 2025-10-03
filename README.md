# 在庫確認・在庫情報通知チャットボット (Dify + GAS)

Difyで構築する在庫確認・入荷通知チャットボット。

## 概要

本チャットボットは、Difyの高度なワークフロー機能を利用し、ユーザーとの対話を通じて以下の機能を提供する。

* **在庫確認** : ユーザーが入力した商品名に基づき、ナレッジベースを検索して在庫情報を回答する。
* **入荷通知予約** : 在庫切れの商品について、入荷時にLINEまたはメールで通知するよう予約できる。
* **ユーザー認証** : LINEログインを利用してユーザーを識別し、通知先をパーソナライズする。
* **外部システム連携** : Google Apps Script (GAS) を介してLINEへの通知送信やユーザー情報の管理を行う。

## アーキテクチャ

主に以下のコンポーネントで構成される。

```mermaid
graph TD
    subgraph Dify Workflow
        A[Start] --> B{Question Classifier};
        B -- ガーデニング用品 --> C[ナレッジ検索];
        B -- その他 --> D[無関係な質問への回答];
        C --> E{在庫の有無判定};
        E -- 在庫あり --> F[在庫情報を回答];
        E -- 在庫なし --> G{入荷通知の希望確認};
        G -- 希望する --> H[通知方法の選択];
        H -- LINE --> I[LINEログインを要求];
        H -- メール --> J[メールアドレスを要求];
        I --> K[GAS Webhook呼び出し<br>(LINE通知登録)];
        J --> L[GAS Webhook呼び出し<br>(メール通知登録)];
    end

    subgraph External Services
        User(LINE User) <--> A;
        K --> GAS(Google Apps Script);
        L --> GAS;
        GAS --> LINE_API(LINE Messaging API);
        GAS --> Mail_Service(メール送信サービス);
    end

    style GAS fill:#f9f,stroke:#333,stroke-width:2px
```

### 主要な処理フロー

1. **質問分類** : ユーザーからの問い合わせを「ガーデニング用品に関する質問」と「その他」に分類する。
2. **ナレッジ検索** : ガーデニング用品に関する質問の場合、登録された商品情報（ナレッジベース）を検索する。
3. **条件分岐** : 在庫の有無やユーザーの応答に応じて、処理が分岐する。在庫がない場合は入荷通知の希望を確認し、在庫が少ない場合は在庫が5以下になった時点での通知の希望を確認する。
4. **ユーザー認証と情報取得** : 入荷通知を希望するユーザーには、LINEログインまたはメールアドレスの入力を促し、通知先を確保する。
5. **外部連携 (GAS)** : LINEログイン後の処理や実際の通知送信には、DifyからGASのWebhookを呼び出す。

### 会話変数 (Conversation Variables)

本アプリでは、ユーザーの状態や通知設定を管理するため以下の会話変数を使用している。

* `linking_conversation_id`: ユーザーセッションを維持するためのID。
* `notification_channel`: 通知方法 (`line` または `email`)。
* `notification_address`: 通知先 (LINEのユーザーIDまたはメールアドレス)。
* `notification_type`: 通知の種類 (`arrival` または `low_stock`)。
* `state`: ユーザーの現在の状態（例: `waiting_for_email`）。
* `notification_product_sku`, `notification_product_name`: 通知対象の商品情報。
***
## セットアップ手順

### 必要なもの

* Difyアカウント
* Googleアカウント
* LINE Developersアカウント（Messaging APIチャネルとLINEログインチャネル）

### 1. Difyへのインポート

1. 本リポジトリにある `在庫確認ボット.yml`ファイルをダウンロードする。
2. Difyで新しいアプリを作成する際に、「DSLファイルからインポート」を選択し、ダウンロードしたファイルをアップロードする。

### 2. 環境変数の設定

インポートしたアプリの「環境変数」セクションで、以下の値を設定する必要がある。

| 変数名 | 説明 | 設定値の例 |
| :--- | :--- | :--- | 
| `line_login_channel_id` | LINEログインのチャネルID | 10桁の数字 |
| `gas_webapp_url` | GASプロジェクトのウェブアプリURL | `https://script.google.com/macros/s/.../exec` |
| `GOOGLE_API_KEY` | Google Sheets APIを利用するためのAPIキー |  |
| `GOOGLE_SHEET_ID` | 在庫データを格納するGoogleスプレッドシートのID |  |

**環境変数の設定手順**

1.  **`gas_webapp_url` の設定:**
    1.  「3. Google Apps Scriptのセットアップ」を完了させ、自身のGASプロジェクトをウェブアプリとしてデプロイする。
    2.  デプロイ後に発行される**ウェブアプリURL**をコピーする。
    3.  Difyアプリの「環境変数」画面で`gas_webapp_url`の値を、2でコピーした自身のURLに書き換える。

2.  **`GOOGLE_API_KEY` と `GOOGLE_SHEET_ID` の設定:**
    1.  Google Cloud Platformで、Google Sheets APIにアクセス可能なAPIキーを生成する。
    2.  在庫データを管理するためのGoogleスプレッドシートを作成し、そのURLからスプレッドシートID（URL中の `.../spreadsheets/d/` と `/edit` の間の長い文字列）をコピーする。
    3.  Difyアプリの「環境変数」画面で、`GOOGLE_API_KEY`と`GOOGLE_SHEET_ID`の値を、それぞれ1と2で取得したものに書き換える。

### 3. Google Apps Scriptのセットアップ

1. Difyと連携するためのGASプロジェクトを作成する。
2. 本リポジトリの `Code.js`をGASエディタにコピー＆ペーストする。
3. LINE Messaging APIのチャネルアクセストークンなどをスクリプトプロパティに設定する。
4. GASプロジェクトを「ウェブアプリ」としてデプロイし、発行されたURLをDifyの `gas_webapp_url`環境変数に設定する。

***
## ウェブページへの組み込み

`index.html`に実装例あり。
