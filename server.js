// haxe-compile-server
//
// Haxeソースコードを受け取り、実際の haxe コンパイラで JavaScript にビルドして
// 結果を返すだけのシンプルなHTTPサーバー。
// Swift Playgrounds 側は POST /compile にソースコードを送り、
// 返ってきた JS を WKWebView 内で実行する想定。

const express = require("express");
const { randomUUID } = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

const app = express();
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 8080;
// 1リクエストあたりのコンパイル時間の上限（ミリ秒）。無限ループ対策。
const COMPILE_TIMEOUT_MS = 10_000;

app.get("/", (_req, res) => {
  res.json({ status: "ok", message: "haxe-compile-server is running" });
});

// haxelibのライブラリ名として許容する文字だけを通す（コマンド引数としての安全対策）
const LIB_NAME_RE = /^[A-Za-z0-9_.\-]+$/;

// POST /compile
// body: {
//   "code": "class Main { static function main() { trace('hi'); } }",
//   "main": "Main",
//   "libs": ["flixel"]   // haxelibでインストール済みのライブラリ名（省略可）
// }
// 戻り値:
//   成功時: { "ok": true, "js": "コンパイルされたJSコード全体" }
//   失敗時: { "ok": false, "error": "haxeコンパイラのエラーメッセージ" }
app.post("/compile", async (req, res) => {
  const { code, main, libs } = req.body || {};

  if (typeof code !== "string" || code.trim().length === 0) {
    return res.status(400).json({ ok: false, error: "'code' (string) is required" });
  }

  const mainClass = typeof main === "string" && main.trim() ? main.trim() : "Main";

  let libList = [];
  if (libs !== undefined) {
    if (!Array.isArray(libs) || !libs.every((l) => typeof l === "string")) {
      return res.status(400).json({ ok: false, error: "'libs' must be an array of strings" });
    }
    libList = libs.map((l) => l.trim()).filter(Boolean);
    const invalid = libList.find((l) => !LIB_NAME_RE.test(l));
    if (invalid) {
      return res.status(400).json({ ok: false, error: `invalid lib name: ${invalid}` });
    }
  }

  // 同時リクエストがぶつからないよう、リクエストごとに一時ディレクトリを作る
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "haxe-"));
  const srcPath = path.join(workDir, `${mainClass}.hx`);
  const outPath = path.join(workDir, "out.js");

  try {
    await fs.writeFile(srcPath, code, "utf8");

    await runHaxe(workDir, mainClass, outPath, libList);

    const js = await fs.readFile(outPath, "utf8");
    res.json({ ok: true, js });
  } catch (err) {
    // Haxeコンパイラのエラーメッセージ（構文エラーなど）をそのまま返す
    res.status(400).json({ ok: false, error: err.message || String(err) });
  } finally {
    // 一時ファイルの掃除（失敗しても無視してOK）
    fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});

function runHaxe(cwd, mainClass, outPath, libList) {
  return new Promise((resolve, reject) => {
    const libArgs = libList.flatMap((lib) => ["-lib", lib]);
    const args = ["-js", outPath, "-main", mainClass, ...libArgs];
    execFile(
      "haxe",
      args,
      { cwd, timeout: COMPILE_TIMEOUT_MS },
      (error, _stdout, stderr) => {
        if (error) {
          // タイムアウトの場合は error.killed === true
          if (error.killed) {
            reject(new Error("compile timed out"));
            return;
          }
          reject(new Error(stderr || error.message));
          return;
        }
        resolve();
      }
    );
  });
}

app.listen(PORT, () => {
  console.log(`haxe-compile-server listening on port ${PORT}`);
});
