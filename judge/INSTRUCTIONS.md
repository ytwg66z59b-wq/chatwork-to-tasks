# 「要返信」判定の手順（定期実行用）

Chatworkのトーク履歴から、Toメンションのうち「宛先の人が答える必要がある内容」で「まだ答えていない」ものを判定し、結果をGoogleドライブに保存する。
Toタスクの画面（Apps Script経由）がこの結果を読んで「要返信」として表示する。

## 使うもの
- トーク履歴のスプレッドシート：fileId `1Ox-C7O-8SL-l4nbH13gh5_sxCDRtzw3TFuA4kangL2w`（シート「ログ」）
- 判定結果の保存先：Googleドライブのフォルダ「Toタスク判定」の中の `to-judgments-*.json`（一番新しいもの1つだけを残す）
- このリポジトリの `judge/` のスクリプト（Node と Python3 + openpyxl）

## 手順
作業は一時フォルダで行う（例：`$WORK`）。リポジトリは `git clone --depth 1 https://github.com/ytwg66z59b-wq/chatwork-to-tasks` で取得する。

1. **履歴を取得**：Google Drive コネクタの `download_file_content` で、上のスプレッドシートを
   `exportMimeType: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` で取得。
   結果（大きいのでファイルに保存される）のJSONの `content` を base64 デコードして `$WORK/log.xlsx` に書く。
2. **前回の判定を取得**：`search_files` で `title contains 'to-judgments-' and trashed = false`（使えなければ `title contains 'to-judgments-'`）を検索し、
   一番新しい（タイトルの日時が最大の）ファイルを `download_file_content` で取得して `$WORK/prev.json` に保存。
   見つからなければ `prev.json` は作らない（初回扱い）。フォルダ「Toタスク判定」のIDもここで控える（`title = 'Toタスク判定'` で検索）。
3. **変換と抽出**
   ```
   python3 judge/xlsx_to_rows.py $WORK/log.xlsx $WORK/rows.json
   node judge/prepare.js $WORK/rows.json $WORK/prev.json $WORK/candidates.json 60
   ```
   `candidates=0` なら**ここで終了**（何もアップロードしない）。
4. **判定**：`candidates.json` を全件読み、下の基準で1件ずつ判定して `$WORK/decisions.json` に書く。
   ```json
   [{ "key": "…candidates の key をそのまま…", "needsReply": true, "answered": false, "reason": "締切確認の質問に未回答" },
    { "key": "…", "needsReply": true, "answered": false, "maybeDone": true, "reason": "翌日の通知で置き換え" }]
   ```
   - `maybeDone` は「たぶん対応済み」のときだけ付ける（下の基準）。画面では「要返信」ではなく「たぶん済み」タブに出る
   - 候補は全件判定する（抜けがあると merge が警告を出すので、その分を追加する）
5. **統合**：`node judge/merge.js $WORK/prev.json $WORK/candidates.json $WORK/decisions.json $WORK/out.json`
6. **保存**：`create_file` で `out.json` の中身を
   - title：`to-judgments-YYYYMMDD-HHmm.json`（日本時間）
   - parentId：フォルダ「Toタスク判定」のID
   - contentMimeType：`application/json`、`disableConversionToGoogleType: true`、`textContent` に中身
   でアップロード。`textContent` には `out.json` の中身を**一字一句そのまま**入れる（`cat` で表示して写す）。
   アップロード結果の `fileSize` が `wc -c out.json` と一致することを確認し、違ったら今アップロードしたファイルをゴミ箱に入れて1回だけやり直す。
   一致したら、手順2で取得した**前回のファイルだけ** `trash_file` でゴミ箱へ。
7. 最後に「候補N件・要返信M件・たぶん済みK件」を一行で報告する。本文の引用はしない。

## 判定の基準
`to` の人の立場で、Toのメッセージ（`body`）を読む。

**needsReply = true**（返答・対応の連絡が必要）
- 質問している（「〜でしょうか？」「〜ですか？」「教えてください」「いかがですか」）
- 確認・判断・承認を求めている（「ご確認いただけますか」「問題ないでしょうか」「どちらで進めますか」）
- 何かの作業や提出を依頼していて、完了の報告や返事が当然期待される（「〜をお願いできますか」「〜までにご提出ください」）
- 日程調整・出欠など、相手の回答がないと先に進まないもの

**needsReply = false**（読めば済む）
- お知らせ・共有・報告だけ（「共有します」「完了しました」「アップデートしました」）
- お礼・あいさつ・了解の返事（「ありがとうございます」「承知しました」「よろしくお願いします」）
- CC として名前が入っているだけで、問いかけの相手ではない
- 定型の自動通知で、個別の返事が要らないもの

**answered（needsReply = true のときだけ判断）**
- `recipientMessagesAfter` は、Toのあとに宛先の人が同じルームで送ったメッセージ。
- その中に、**問いかけの中身に答えている**、または**依頼への対応完了・回答を伝えている**ものがあれば answered = true。
- `isReplyToThis: true`（REで返信）でも、「確認します」「少々お待ちください」だけなら answered = false のまま。
- 別の話題への発言しかないなら answered = false。
- 複数人に同じ依頼・質問をしていて、`othersRepliesToThis`（他の宛先の人のRE）で**すでに誰かが対応・回答済み**なら answered = true（reason 例：「他の人が対応済」）。
- 毎日届く自動通知（「未対応の応募者がいます」など）は、依頼として needsReply = true。本人の発言でその対応が済んだと読み取れなければ answered = false。
- `ruleDone` はルールでの自動判定（参考程度）。中身で判断する。
- `previous` は前回の判定理由（再判定のときだけ入る）。

**maybeDone（needsReply = true かつ answered = false のときだけ判断）**
はっきり答えた・済んだとは言えないが、済んでいそうなもの。消すのではなく「たぶん済み」に分けるだけなので、迷ったら付けてよい。
- `laterSameSenderTos` に同じ種類の新しい通知（「未対応の応募者がいます」「合否未送信アラート」など）があり、古い方の依頼が新しい方に引き継がれている（reason 例：「翌日の通知で置き換え」）
- `othersRepliesToThis` で他の宛先の人が答えているが、自分の分まで済んだかははっきりしない（reason 例：「他の人が一部回答」）
- 本人がREで「確認します」「対応します」と返していて、その後の結果報告はないが、作業はチャット外（スプレッドシート等）で済んでいそう（reason 例：「対応予定の返信あり」）
- 付けないもの：本人宛ての個別の質問・判断・承認が残っているのに、誰も答えていないもの（これは要返信のまま）

**reason**：画面に出す短い理由。25文字以内の日本語。例：「日程の可否を質問・未回答」「共有のみ（返答不要）」「修正依頼に完了報告済み」
