# haxe-compile-server

Haxeソースコードを受け取り、実際の `haxe` コンパイラで JavaScript にビルドして返すだけの
シンプルなHTTPサーバーです。Swift Playgrounds 側は Haxe コンパイラを直接動かせないため、
このサーバーにソースを送って JS を受け取り、`WKWebView` 内で実行する構成を想定しています。

## 1. Codespacesでのセットアップ

`.devcontainer/devcontainer.json` に Haxe をインストールするfeatureを指定していますが、
このfeatureが使えない/見つからない場合は、Codespaces起動後に手動でインストールしてください。

```bash
# Haxeが入っているか確認
haxe -version

# 入っていない場合（Ubuntuベースのイメージ想定）
sudo apt-get update
sudo apt-get install -y haxe

# それでも入らない場合は公式配布物から
curl -LO https://github.com/HaxeFoundation/haxe/releases/download/4.3.6/haxe-4.3.6-linux64.tar.gz
tar xzf haxe-4.3.6-linux64.tar.gz
export PATH="$PWD/haxe_20240101:$PATH"   # 展開後のディレクトリ名に合わせて調整
```

Node依存をインストールして起動:

```bash
npm install
npm start
```

`Codespacesの「ポート」タブ`でポート8080が転送されたら、その公開URL（
`https://xxxx-8080.app.github.dev` のような形）が Swift Playgrounds からアクセスするURLになります。
ポートの可視性は **Public** に変更しておいてください（Privateだと認証が必要になり、
Playgroundsから素直に叩けません）。

## 2. 動作確認（curl）

```bash
curl -X POST http://localhost:8080/compile \
  -H "Content-Type: application/json" \
  -d '{
    "code": "class Main { static function main() { trace(\"hello from haxe\"); } }"
  }'
```

成功すると `{"ok":true,"js":"...(function () { ... })();"}` のようなJSONが返ります。
構文エラーがあると `{"ok":false,"error":"..."}` が返ります。

## 3. API仕様

### `POST /compile`

リクエストボディ:

```json
{
  "code": "class Main { static function main() { trace('hi'); } }",
  "main": "Main"
}
```

- `code`（必須）: Haxeソースコード全体。クラス名は `main` パラメータと一致させる必要があります。
- `main`（省略可、デフォルト `"Main"`）: エントリーポイントのクラス名。

レスポンス（成功時）:

```json
{ "ok": true, "js": "コンパイル済みJS全体" }
```

レスポンス（失敗時、ステータス400）:

```json
{ "ok": false, "error": "haxeコンパイラのエラーメッセージ" }
```

## 4. Swift Playgrounds側の呼び出し例

```swift
struct CompileResponse: Decodable {
    let ok: Bool
    let js: String?
    let error: String?
}

func compileHaxe(source: String, serverURL: URL) async throws -> String {
    var request = URLRequest(url: serverURL.appendingPathComponent("compile"))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder().encode(["code": source])

    let (data, _) = try await URLSession.shared.data(for: request)
    let result = try JSONDecoder().decode(CompileResponse.self, from: data)

    guard result.ok, let js = result.js else {
        throw NSError(domain: "HaxeCompile", code: 1,
                       userInfo: [NSLocalizedDescriptionKey: result.error ?? "unknown error"])
    }
    return js
}
```

受け取った `js` を、あらかじめ用意したHTMLラッパーに埋め込んで `WKWebView.loadHTMLString` に渡せば、
コンパイル結果をその場で実行できます。

```swift
let html = """
<!DOCTYPE html><html><body>
<script>\(js)</script>
</body></html>
"""
webView.loadHTMLString(html, baseURL: nil)
```

## 5. 注意点

- このサーバーは認証なしで誰でも `/compile` を叩ける状態なので、Codespacesのポートを
  Publicにしている間は他人にも叩かれ得ます。実験用途のみにとどめ、常時公開はしないでください。
- `COMPILE_TIMEOUT_MS`（`server.js` 内）でコンパイル時間に上限を設けていますが、
  実行時の無限ループ（`while(true){}` など）まではここでは防げません。今後 `--interp` や
  実行結果自体もサーバー側で試すなら、実行時タイムアウトも別途検討してください。
