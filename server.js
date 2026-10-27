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
const fsSync = require("fs");
const { execFile, spawn } = require("child_process");
const { promisify } = require("util");
const execFileP = promisify(execFile);

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


// =====================================================================
// FNF (Psych Engine) HTML5 ビルド用の追加エンドポイント
//
//   POST   /build          lime でHTML5ビルドを開始（非同期）
//   GET    /build/status   ビルド状態とログ末尾
//   GET    /mods           サーバー上のmod一覧
//   POST   /mods/:name     modのzip（バイナリ本文）をアップロードして展開
//   DELETE /mods/:name     modを削除
//   GET    /play/...       ビルド結果（HTML5）の静的配信
//
// 環境変数:
//   FNF_DIR      Psych Engineのリポジトリ（既定: ./fnf）
//   BUILD_CMD    ビルドコマンド（既定: "lime build html5 -release"）
//   API_TOKEN    設定すると /build /mods に x-token ヘッダーが必要になる
// =====================================================================
const FNF_DIR = path.resolve(process.env.FNF_DIR || path.join(__dirname, "fnf"));
const BUILD_CMD = process.env.BUILD_CMD || "lime build html5 -release";
const BIN_DIR = path.join(FNF_DIR, "export", "release", "html5", "bin");
const BUILD_TIMEOUT_MS = 30 * 60 * 1000;
const API_TOKEN = process.env.API_TOKEN || "";
const MOD_NAME_RE = /^[A-Za-z0-9_.\-]+$/;

function auth(req, res, next) {
  if (!API_TOKEN) return next();
  if (req.get("x-token") === API_TOKEN || req.query.token === API_TOKEN) return next();
  res.status(401).json({ ok: false, error: "unauthorized" });
}

function validModName(name) {
  return MOD_NAME_RE.test(name) && name !== "." && name !== "..";
}

const build = { state: "idle", startedAt: null, finishedAt: null, exitCode: null, log: [] };

function pushLog(chunk) {
  for (const line of chunk.toString().split(/\r?\n/)) {
    if (line) build.log.push(line);
  }
  if (build.log.length > 300) build.log.splice(0, build.log.length - 300);
}

app.post("/build", auth, (_req, res) => {
  if (build.state === "building") {
    return res.status(409).json({ ok: false, error: "already building" });
  }
  if (!fsSync.existsSync(FNF_DIR)) {
    return res.status(400).json({ ok: false, error: `FNF_DIR not found: ${FNF_DIR} (run setup-fnf.sh)` });
  }

  Object.assign(build, { state: "building", startedAt: Date.now(), finishedAt: null, exitCode: null, log: [] });

  const [cmd, ...args] = BUILD_CMD.split(/\s+/);
  const child = spawn(cmd, args, { cwd: FNF_DIR });
  const timer = setTimeout(() => {
    pushLog("build timed out");
    child.kill("SIGKILL");
  }, BUILD_TIMEOUT_MS);

  const finish = (state, code) => {
    clearTimeout(timer);
    Object.assign(build, { state, exitCode: code, finishedAt: Date.now() });
  };
  child.stdout.on("data", pushLog);
  child.stderr.on("data", pushLog);
  child.on("error", (e) => {
    pushLog(`failed to start: ${e.message}`);
    finish("error", -1);
  });
  child.on("close", (code) => finish(code === 0 ? "done" : "error", code));

  res.json({ ok: true, state: build.state });
});

app.get("/build/status", auth, (_req, res) => {
  const { state, startedAt, finishedAt, exitCode, log } = build;
  res.json({ ok: true, state, startedAt, finishedAt, exitCode, log: log.slice(-60) });
});

app.get("/mods", auth, async (_req, res) => {
  try {
    const entries = await fs.readdir(path.join(FNF_DIR, "mods"), { withFileTypes: true });
    res.json({ ok: true, mods: entries.filter((e) => e.isDirectory()).map((e) => e.name) });
  } catch {
    res.json({ ok: true, mods: [] });
  }
});

app.post("/mods/:name", auth, express.raw({ type: () => true, limit: "300mb" }), async (req, res) => {
  const name = req.params.name;
  if (!validModName(name)) return res.status(400).json({ ok: false, error: "invalid mod name" });
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ ok: false, error: "zip body is required" });
  }

  const dest = path.join(FNF_DIR, "mods", name);
  const tmp = path.join(os.tmpdir(), `mod-${randomUUID()}.zip`);
  try {
    await fs.writeFile(tmp, req.body);
    await fs.rm(dest, { recursive: true, force: true });
    await fs.mkdir(dest, { recursive: true });
    await execFileP("unzip", ["-o", "-q", tmp, "-d", dest], { timeout: 120_000 });

    // zipの中身が「フォルダ1個だけ」なら、1段ほどいて mods/<name>/ 直下に揃える
    const entries = await fs.readdir(dest, { withFileTypes: true });
    if (entries.length === 1 && entries[0].isDirectory()) {
      const inner = path.join(dest, entries[0].name);
      for (const child of await fs.readdir(inner)) {
        await fs.rename(path.join(inner, child), path.join(dest, child));
      }
      await fs.rm(inner, { recursive: true, force: true });
    }
    res.json({ ok: true, name, note: "modはビルド時に同梱されるので、反映には /build が必要です" });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || String(err) });
  } finally {
    fs.rm(tmp, { force: true }).catch(() => {});
  }
});

app.delete("/mods/:name", auth, async (req, res) => {
  const name = req.params.name;
  if (!validModName(name)) return res.status(400).json({ ok: false, error: "invalid mod name" });
  await fs.rm(path.join(FNF_DIR, "mods", name), { recursive: true, force: true });
  res.json({ ok: true, name });
});

// ビルド結果（WKWebViewはここを開く）
app.use(
  "/play",
  (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  },
  express.static(BIN_DIR)
);

app.listen(PORT, () => {
  console.log(`haxe-compile-server listening on port ${PORT}`);
});
