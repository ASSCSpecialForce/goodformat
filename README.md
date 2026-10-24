# goodformat：讓 AI 回答直接輸出圖表

讓聊天 AI 在回答裡輸出圖表、數字卡片、流程和卡片。
不需要 tool call，也不用跑 Python：模型在回答中寫一個 JSON 程式碼區塊，前端就把它畫出來。

這個 repo 只有兩樣東西：

1. **前端元件**（React）：負責把 JSON 區塊畫成圖。
2. **提示詞**（`AGENTS.md`）：教模型依資料的結構選對圖。

## 運作方式

模型的回答是 Markdown。它在需要畫圖的地方寫一段：

````markdown
```chart
{"kind": "bar", "unit": "<單位>", "items": [{"label": "<類別>", "value": 123}]}
```
````

前端的 Markdown renderer 遇到語言標籤是 `stats`、`flow`、`cards`、`chart` 的程式碼區塊時，不顯示原始碼，改交給元件畫圖。

- **串流中**：模型還沒寫完時，元件會把只寫到一半的 JSON 補完（關掉沒關的字串和括號），把已經完整的項目先畫出來。還沒有任何完整項目時，顯示骨架（灰色的佔位框），不會出現原始 JSON。
- **寫完後**：JSON 不合法或格式不對時，退回顯示成普通程式碼區塊，不會讓畫面壞掉。

## 檔案

| 檔案 | 做什麼 |
|---|---|
| `src/WidgetBlock.tsx` | 入口。匯出 `WIDGET_LANGS`、`renderWidget`、`WidgetSkeleton`。處理 `stats`、`flow`、`cards`，並補完串流中的 JSON |
| `src/WidgetBlock.module.css` | 上面 3 種區塊和骨架的樣式 |
| `src/ChartBlock.tsx` | `chart` 區塊。用手寫 SVG 畫 8 種圖，不需要圖表套件 |
| `src/ChartBlock.module.css` | 圖表樣式、色盤、深色模式 |
| `integration/render.tsx.diff` | 原專案怎麼把元件接進 Markdown renderer（參考用） |
| `AGENTS.md` | 給模型的提示詞。每次對話都要載入 |

唯一的依賴是 React（用到 hooks）。CSS 用的是 CSS Modules（`import css from './X.module.css'`）。

## 8 種圖（`chart` 的 `kind`）

| kind | 用在什麼資料 |
|---|---|
| `bar` | 每個類別一個值。可以排序、設基準值（`baseline`）、畫參考線（`ref`）、標示估計值（`est`） |
| `line` | 有順序的軸（例如時間）。可以用 `estFrom` 讓預測的部分變成虛線 |
| `stacked` | 幾個整體各自的組成（100% 堆疊） |
| `range` | 有上下界的估計值 |
| `histogram` | 一組原始觀察值的分布。分組數由前端計算 |
| `box` | 多組原始觀察值的分布。四分位數由前端計算 |
| `scatter` | 同一批項目的兩個數值變數，最多 3 組 |
| `waterfall` | 起始值，加上正負變化，再到結束值 |

完整的 JSON 格式寫在 `AGENTS.md` 的「Block formats」一節。前端和提示詞用的是同一份格式，兩邊要一起改。

## 怎麼接進你的 harness

### 1. 前端

1. 把 `src/` 的 4 個檔案放進你的 Markdown 元件旁邊。
2. 在 renderer 處理 code block 的地方加上這段（完整位置見 `integration/render.tsx.diff`）：

```tsx
import { WIDGET_LANGS, WidgetSkeleton, renderWidget } from './WidgetBlock.tsx'

// 在畫 code block 之前：
if (lang !== undefined && WIDGET_LANGS.has(lang)) {
  const widget = renderWidget(lang, code, key, isStreaming)
  if (widget !== null) return widget
  if (isStreaming) return <WidgetSkeleton key={key} />
}
// 否則照原本的方式畫 code block
```

- `lang`：程式碼區塊的語言標籤。
- `code`：區塊內容（JSON 字串）。
- `isStreaming`：這則訊息是不是還在生成中。你的 renderer 需要能把這個狀態傳進來。

3. **深色模式**：`ChartBlock.module.css` 用 `:global(body[data-ds-dark-theme]) .chart` 切換深色色盤。這是原專案的選擇器，請改成你的深色模式選擇器，例如 `:global(.dark) .chart` 或 `@media (prefers-color-scheme: dark)`。
4. 如果你的專案 import 時不寫 `.tsx` 副檔名，就把 import 路徑裡的 `.tsx` 拿掉。

### 2. 提示詞

把 `AGENTS.md` 的內容放進每次對話都會載入的 system prompt。

- 它教模型先描述資料（單位、類別有沒有順序、每類幾個值、能不能加總、有沒有上下界），再依固定順序選區塊。
- **不要在裡面加範例答案或具體資料。** 加了以後，模型會照抄範例，不會自己判斷。
- 模型在聊天中不要另外用 Python 或圖片畫圖。提示詞第一段已經這樣寫。

## 怎麼確認接好了

在聊天中，請模型「把下面的資料畫成圖」，貼一組資料。或者直接讓前端 render 一則含有下面內容的訊息：

````markdown
```stats
{"items": [{"label": "A", "value": "10 %"}, {"label": "B", "value": "3.2 億"}]}
```

```chart
{"kind": "line", "unit": "%", "x": ["1", "2", "3", "4"], "series": [{"name": "s", "values": [1, 3, 2, 4], "estFrom": "3"}]}
```
````

應該看到：

- 2 張數字卡片。
- 一條折線，從第 3 點開始變成虛線。

在串流中，畫面不應該出現原始 JSON。

## 來源

選圖規則整理自：

- Claus O. Wilke, *Fundamentals of Data Visualization*
- From Data to Viz (data-to-viz.com)
- Financial Times, *Visual Vocabulary*
- OpenStax, *Introductory Statistics*

其中，預測和估計值的標示方式（`est`、`estFrom`）是本專案自己的設計。上面這些來源沒有給這方面的規則。
