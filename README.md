# ArUco マーカー検出 & SVG変換ツール

ブラウザ上でOpenCV.jsを使用してArUcoマーカーを検出し、内側の四角形をSVGとして保存するツールです。

## 機能

- 5x5 ArUcoマーカー（ID: 0-3）の検出
- 4つのマーカー中心点を結んだ内側の四角形の抽出
- SVG形式でのパス出力
- SVGファイルのダウンロード機能
- テストマーカー生成ツール付属

## 使い方

### テストマーカーの生成
1. ブラウザで `test-marker-generator.html` を開く
2. 画像サイズとマーカーサイズを調整（マーカーサイズは7の倍数）
3. 「画像をダウンロード」ボタンでテスト画像を保存

### マーカーの検出とSVG変換
1. ブラウザで `index.html` を開く
2. ArUcoマーカー（ID: 0-3）を4辺の端に配置した画像をアップロード
3. マーカーが検出され、内側の四角形がSVGで表示されます
4. 「SVGをダウンロード」ボタンでSVGファイルを保存

## 必要な環境

- モダンなWebブラウザ（Chrome, Firefox, Safari, Edgeなど）
- ローカルサーバー（ファイルプロトコルではなくHTTPプロトコルで実行する必要があります）

## セットアップ

```bash
# Pythonでローカルサーバーを起動
python3 -m http.server 8000

# または Node.jsの場合
npx http-server -p 8000
```

ブラウザで `http://localhost:8000` を開いてください。

## 重要な制限事項

**js-arucoライブラリの制限:**
- サポートされるマーカー: 5x5の内部データ領域を持つArUcoマーカーのみ
- サポートされるID: 0, 1, 2, 3 の4種類のみ
- マーカー形式: 7x7マス（外枠1 + データ5x5 + 外枠1）

## マーカーの配置

画像内に以下のIDのArUcoマーカーを配置してください：
- ID 0: 左上
- ID 1: 右上
- ID 2: 右下
- ID 3: 左下

※実際の位置は自動的に判定されますが、4つのマーカーが必要です。
※テストマーカー生成ツール（`test-marker-generator.html`）を使用すると簡単に作成できます。

## 技術スタック

- js-aruco (JavaScript ArUco marker detector)
- HTML5 Canvas
- SVG

## ファイル構成

- `index.html` - メインのHTMLファイル
- `aruco-detector.js` - ArUco検出とSVG生成のロジック
- `svd.js`, `posit1.js`, `cv.js`, `aruco.js` - js-arucoライブラリ

## ライセンス

MIT
