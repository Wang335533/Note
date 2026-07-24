import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import storeModule from "../shared/store.cjs";

const { applyOperation, createInitialState } = storeModule;

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requestedExecutable = process.argv[2] ? path.resolve(process.argv[2]) : null;
const executable = requestedExecutable
  || path.join(projectRoot, "node_modules", "electron", "dist", "electron.exe");
const args = requestedExecutable ? [] : [projectRoot];
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const tableMarkdownFixture = [
  "| Panel | 理论问题 | 推荐调节变量 | 预期交互方向 |",
  "|---|---|---|---|",
  "| A. 替代性信息供给 | 市场是否已有其他渠道回答类似问题 | Analyst Coverage; Management Guidance Frequency | 负 |",
  "| B. 信息不确定性 | 新分析框架是否更有价值 | Forecast Dispersion; Strategic Differentiation | 正 |",
  "| C. 专业处理 | 新信息能否被投资者吸收 | Participation Quantity; Research-intensive Participant Share | 正 |",
].join("\n");

async function reservePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (!port) throw new Error("Could not reserve a DevTools port");
  return port;
}

async function waitForTarget(port, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
        if (page) return page;
      }
    } catch {
      // DevTools is still starting.
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for the Electron renderer");
}

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  const exceptions = [];
  let nextId = 0;

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
      return;
    }
    if (message.method === "Runtime.exceptionThrown") {
      exceptions.push(message.params?.exceptionDetails?.text || "Renderer exception");
    }
  });

  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

  return { socket, send, exceptions };
}

async function evaluate(send, expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Renderer evaluation failed");
  }
  return result.result?.value;
}

async function waitFor(send, expression, description) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await evaluate(send, expression);
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitForValue(read, description) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function platformFontsForSelector(send, selector) {
  const { root } = await send("DOM.getDocument", { depth: -1 });
  const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector });
  if (!nodeId) throw new Error(`Could not find font inspection target: ${selector}`);
  const { fonts } = await send("CSS.getPlatformFontsForNode", { nodeId });
  return fonts;
}

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "note-desktop-smoke-"));
const appData = path.join(temporaryRoot, "Roaming");
const localAppData = path.join(temporaryRoot, "Local");
const isolatedUserData = path.join(temporaryRoot, "userData");
await Promise.all([
  fs.mkdir(appData, { recursive: true }),
  fs.mkdir(localAppData, { recursive: true }),
  fs.mkdir(isolatedUserData, { recursive: true }),
]);

const legacyNoteId = "legacy-smoke-note";
const legacyMarker = '<font data-note-font="times-new-roman">Legacy migration text</font>';
let legacyState = applyOperation(createInitialState(new Date()), {
  type: "note:add",
  title: "Legacy migration",
  body: legacyMarker,
}, new Date(), { randomUUID: () => legacyNoteId });
legacyState.schemaVersion = 2;
delete legacyState.notes[legacyNoteId].richBody;
legacyState.settings.activeModule = "notes";
legacyState.settings.notesLastNotebookId = "all";
legacyState.settings.notesLastNoteId = legacyNoteId;
legacyState.settings.notesPane = "editor";
const smokeDataDirectory = path.join(isolatedUserData, "note-data");
const smokeStatePath = path.join(smokeDataDirectory, "state.json");
await fs.mkdir(smokeDataDirectory, { recursive: true });
await fs.writeFile(smokeStatePath, `${JSON.stringify(legacyState, null, 2)}\n`, "utf8");

const port = await reservePort();
const child = spawn(executable, [...args, `--remote-debugging-port=${port}`], {
  cwd: projectRoot,
  env: {
    ...process.env,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    NOTE_SMOKE_USER_DATA: isolatedUserData,
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let processOutput = "";
child.stdout.on("data", (chunk) => { processOutput += chunk.toString(); });
child.stderr.on("data", (chunk) => { processOutput += chunk.toString(); });

let cdp;
try {
  const target = await waitForTarget(port, child);
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");

  const todo = await waitFor(
    cdp.send,
    `(() => {
      const root = document.querySelector("#root");
      const moduleSwitch = document.querySelector(".module-switch");
      if (!root?.textContent || !moduleSwitch) return null;
      return {
        readyState: document.readyState,
        title: document.title,
        text: moduleSwitch.textContent.replace(/\\s+/g, " ").trim(),
        desktopBridge: Boolean(window.noteDesktop),
        script: document.querySelector("script[type=module]")?.getAttribute("src") || "",
      };
    })()`,
    "the Todo workspace",
  );

  if (!todo.desktopBridge || !todo.text.includes("Todo") || !todo.text.includes("Notes")) {
    throw new Error(`Unexpected Todo workspace state: ${JSON.stringify(todo)}`);
  }

  const maximizeResult = await evaluate(cdp.send, `window.noteDesktop.toggleMaximize()`);
  if (!maximizeResult?.ok) throw new Error(`Could not maximize the desktop window: ${JSON.stringify(maximizeResult)}`);
  await waitFor(
    cdp.send,
    `document.querySelector('button[aria-label="还原窗口"]')?.getAttribute('aria-label')`,
    "the maximized desktop window state",
  );
  const restoreResult = await evaluate(cdp.send, `window.noteDesktop.toggleMaximize()`);
  if (!restoreResult?.ok) throw new Error(`Could not restore the desktop window: ${JSON.stringify(restoreResult)}`);
  await waitFor(
    cdp.send,
    `document.querySelector('button[aria-label="最大化窗口"]')?.getAttribute('aria-label')`,
    "the restored desktop window state",
  );

  await evaluate(cdp.send, `document.querySelector(".module-switch button:last-child")?.click()`);
  const notes = await waitFor(
    cdp.send,
    `(() => {
      const workspace = document.querySelector(".notes-workspace");
      if (!workspace) return null;
      return { text: workspace.textContent.replace(/\\s+/g, " ").trim().slice(0, 160) };
    })()`,
    "the Notes workspace",
  );

  const legacyMigration = await waitFor(
    cdp.send,
    `(() => {
      const editor = document.querySelector('.rich-note-prosemirror');
      const styled = editor?.querySelector('[style*="Times New Roman"]');
      if (!editor?.textContent.includes('Legacy migration text') || !styled) return null;
      return {
        text: editor.textContent,
        font: getComputedStyle(styled).fontFamily,
        rawMarkerVisible: /<font\\s+data-note-font/i.test(editor.textContent),
      };
    })()`,
    "the legacy note migration",
  );
  const legacyPersistence = await waitForValue(async () => {
    const persisted = JSON.parse(await fs.readFile(smokeStatePath, "utf8"));
    const note = persisted.notes?.[legacyNoteId];
    if (!note?.richBody || /<\/?font\b/i.test(note.body || "")) return null;
    return { schemaVersion: persisted.schemaVersion, richBodyType: note.richBody.type };
  }, "the migrated rich note to reach disk");
  if (legacyMigration.rawMarkerVisible || !legacyMigration.font.includes("Times New Roman")) {
    throw new Error(`Unexpected legacy migration state: ${JSON.stringify(legacyMigration)}`);
  }

  const rawTableCreated = await evaluate(cdp.send, `(async () => {
    const result = await window.noteDesktop.mutate({
      type: 'note:add',
      title: 'Raw table migration',
      richBody: {
        type: 'doc',
        content: ${JSON.stringify(tableMarkdownFixture.split("\n"))}.map((text) => ({
          type: 'paragraph',
          content: [{ type: 'text', text }],
        })),
      },
    });
    return {
      ok: result?.ok,
      id: result?.state?.settings?.notesLastNoteId || null,
    };
  })()`);
  if (!rawTableCreated?.ok || !rawTableCreated.id) {
    throw new Error(`Could not create the raw table migration fixture: ${JSON.stringify(rawTableCreated)}`);
  }
  const rawTableMigration = await waitFor(
    cdp.send,
    `(() => {
      const table = document.querySelector('.rich-note-prosemirror table');
      if (!table || table.rows.length !== 4 || table.querySelectorAll('th').length !== 4) return null;
      return {
        rows: table.rows.length,
        columns: table.rows[0]?.cells.length || 0,
        rawDelimiterVisible: document.querySelector('.rich-note-prosemirror')?.textContent.includes('|---|'),
      };
    })()`,
    "the existing raw Markdown table migration",
  );
  const rawTableMigrationPersistence = await waitForValue(async () => {
    const persisted = JSON.parse(await fs.readFile(smokeStatePath, "utf8"));
    const table = persisted.notes?.[rawTableCreated.id]?.richBody?.content?.find((node) => node.type === "table");
    if (!table) return null;
    return {
      rows: table.content.length,
      columns: table.content[0]?.content?.length || 0,
      firstCellType: table.content[0]?.content?.[0]?.type,
    };
  }, "the migrated raw table to reach disk");
  if (rawTableMigration.rawDelimiterVisible || rawTableMigrationPersistence.firstCellType !== "tableHeader") {
    throw new Error(`Unexpected raw table migration: ${JSON.stringify({ rawTableMigration, rawTableMigrationPersistence })}`);
  }

  await evaluate(cdp.send, `document.querySelector('button[aria-label="新建笔记"]')?.click()`);
  await waitFor(
    cdp.send,
    `Boolean(document.querySelector('.rich-note-prosemirror[contenteditable="true"]'))`,
    "the rich note editor",
  );
  const richNoteId = await evaluate(cdp.send, `(async () => {
    const result = await window.noteDesktop.getState();
    return result?.state?.settings?.notesLastNoteId || null;
  })()`);
  if (!richNoteId) throw new Error("Could not identify the rich-note smoke fixture");
  await evaluate(cdp.send, `(() => {
    const editor = document.querySelector('.rich-note-prosemirror');
    editor.focus();
    document.execCommand('insertText', false, '中文 Packaged Rich Text 123');
    const text = editor.querySelector('p')?.firstChild;
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 2);
    selection.removeAllRanges();
    selection.addRange(range);
    document.querySelector('button[aria-label="更多格式"]')?.click();
  })()`);
  await waitFor(cdp.send, `Boolean(document.querySelector('.more-format-popover select'))`, "the rich formatting menu");
  await evaluate(cdp.send, `(() => {
    const font = document.querySelector('.more-format-popover select');
    font.value = 'kaiti';
    font.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor(
    cdp.send,
    `document.querySelector('.rich-note-prosemirror [style*="KaiTi"]')?.textContent === '中文'`,
    "the explicit Chinese font",
  );
  const basePlatformFonts = await platformFontsForSelector(cdp.send, ".rich-note-prosemirror p");
  await evaluate(cdp.send, `(() => {
    const editor = document.querySelector('.rich-note-prosemirror');
    editor.focus();
    document.execCommand('selectAll');
    if (!document.querySelector('.more-format-popover')) {
      document.querySelector('button[aria-label="更多格式"]')?.click();
    }
  })()`);
  await waitFor(cdp.send, `Boolean(document.querySelector('.more-format-popover select'))`, "the rich formatting menu");
  await evaluate(cdp.send, `(() => {
    const font = document.querySelector('.more-format-popover select');
    font.value = 'times-new-roman';
    font.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const richEditor = await waitFor(
    cdp.send,
    `(() => {
      const editor = document.querySelector('.rich-note-prosemirror');
      const western = editor?.querySelector('[style*="Times New Roman"]');
      const eastAsian = editor?.querySelector('[style*="KaiTi"]');
      if (!editor || !western || !eastAsian) return null;
      return {
        text: editor.textContent,
        westernText: western.textContent,
        westernFont: getComputedStyle(western).fontFamily,
        eastAsianText: eastAsian.textContent,
        eastAsianFont: getComputedStyle(eastAsian).fontFamily,
        rawMarkerVisible: /<font\\s+data-note-font/i.test(editor.textContent),
      };
    })()`,
    "a real Times New Roman mark",
  );
  if (
    richEditor.rawMarkerVisible
    || !richEditor.westernFont.includes("Times New Roman")
    || !richEditor.eastAsianFont.includes("KaiTi")
    || /\p{Script=Han}/u.test(richEditor.westernText)
    || richEditor.eastAsianText !== "中文"
  ) {
    throw new Error(`Unexpected rich editor state: ${JSON.stringify(richEditor)}`);
  }
  const platformFonts = await platformFontsForSelector(
    cdp.send,
    ".rich-note-prosemirror p",
  );
  const timesFont = platformFonts.find((font) => /Times New Roman/i.test(font.familyName) && font.glyphCount > 0);
  const eastAsianFont = platformFonts.find((font) => /KaiTi/i.test(font.familyName) && font.glyphCount > 0);
  const baseEastAsianFont = basePlatformFonts.find((font) => font.glyphCount === 2);
  if (!timesFont || !eastAsianFont || eastAsianFont.familyName !== baseEastAsianFont?.familyName) {
    throw new Error(`Times New Roman did not preserve a separate East Asian font: ${JSON.stringify(platformFonts)}`);
  }

  await evaluate(cdp.send, `(() => {
    const editor = document.querySelector('.rich-note-prosemirror');
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    editor.focus();
    document.querySelector('button[aria-label^="放大一号字体"]')?.click();
  })()`);
  const increasedFontSize = await waitFor(
    cdp.send,
    `(() => {
      const styled = document.querySelector('.rich-note-prosemirror [style*="font-size: 16px"]');
      return styled ? getComputedStyle(styled).fontSize : null;
    })()`,
    "the increased rich-text font size",
  );
  await evaluate(cdp.send, `document.querySelector('button[aria-label^="缩小一号字体"]')?.click()`);
  const decreasedFontSize = await waitFor(
    cdp.send,
    `(() => {
      const styled = document.querySelector('.rich-note-prosemirror [style*="font-size: 14px"]');
      return styled ? getComputedStyle(styled).fontSize : null;
    })()`,
    "the decreased rich-text font size",
  );

  await evaluate(cdp.send, `(() => {
    const editor = document.querySelector('.rich-note-prosemirror');
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    editor.focus();
    const more = document.querySelector('button[aria-label="更多格式"]');
    if (!document.querySelector('.more-format-popover')) more?.click();
    const lineHeight = document.querySelectorAll('.more-format-popover select')[2];
    lineHeight.value = '2';
    lineHeight.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const lineHeightEditor = await waitFor(
    cdp.send,
    `(() => {
      const paragraph = document.querySelector('.rich-note-prosemirror p[style*="line-height"]');
      if (!paragraph) return null;
      return { style: paragraph.getAttribute('style'), lineHeight: getComputedStyle(paragraph).lineHeight };
    })()`,
    "a persisted paragraph line height",
  );

  await evaluate(cdp.send, `(() => {
    const editor = document.querySelector('.rich-note-prosemirror');
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    editor.focus();
    const more = document.querySelector('button[aria-label="更多格式"]');
    if (!document.querySelector('.more-format-popover')) more?.click();
    document.querySelector('button[aria-label^="插入公式"]')?.click();
  })()`);
  await waitFor(cdp.send, `Boolean(document.querySelector('.math-editor-popover textarea'))`, "the formula editor");
  await evaluate(cdp.send, `(() => {
    const input = document.querySelector('.math-editor-popover textarea');
    const value = String.raw\`x=\\begin{cases}1 & \\text{yes}\\\\0 & \\text{no}\\end{cases}\`;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(cdp.send, `Boolean(document.querySelector('.math-editor-preview .katex'))`, "the KaTeX formula preview");
  await evaluate(cdp.send, `document.querySelector('.math-editor-popover button.is-primary')?.click()`);
  const formulaEditor = await waitFor(
    cdp.send,
    `(() => {
      const formula = document.querySelector('[data-type="inline-math"], [data-type="block-math"]');
      if (!formula?.querySelector('.katex')) return null;
      return {
        type: formula.getAttribute('data-type'),
        latex: formula.getAttribute('data-latex'),
        rendered: Boolean(formula.querySelector('.katex')),
        rawDelimiterVisible: /\\$\\$|\\\\\\[/.test(formula.textContent),
      };
    })()`,
    "the persisted KaTeX formula",
  );
  if (!formulaEditor.rendered || formulaEditor.rawDelimiterVisible || !formulaEditor.latex.includes("begin{cases}")) {
    throw new Error(`Unexpected formula editor state: ${JSON.stringify(formulaEditor)}`);
  }

  await evaluate(cdp.send, `(() => {
    const editor = document.querySelector('.rich-note-prosemirror');
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    editor.focus();
    const clipboard = new DataTransfer();
    clipboard.setData('text/plain', ${JSON.stringify(tableMarkdownFixture)});
    editor.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: clipboard,
    }));
  })()`);
  const pastedTable = await waitFor(
    cdp.send,
    `(() => {
      const table = document.querySelector('.rich-note-prosemirror table');
      if (!table || table.rows.length !== 4 || table.querySelectorAll('th').length !== 4) return null;
      return {
        rows: table.rows.length,
        columns: table.rows[0]?.cells.length || 0,
        headers: table.querySelectorAll('th').length,
        rawPipesVisible: table.textContent.includes('|---|'),
        wrapperScrollable: getComputedStyle(table.closest('.tableWrapper')).overflowX,
      };
    })()`,
    "the pasted editable Markdown table",
  );
  if (pastedTable.columns !== 4 || pastedTable.rawPipesVisible || pastedTable.wrapperScrollable !== "auto") {
    throw new Error(`Unexpected pasted table: ${JSON.stringify(pastedTable)}`);
  }

  await evaluate(cdp.send, `(() => {
    const cell = document.querySelector('.rich-note-prosemirror table tbody tr:nth-child(2) td');
    const paragraph = cell?.querySelector('p');
    if (!paragraph) return false;
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    paragraph.closest('[contenteditable="true"]')?.focus();
    document.dispatchEvent(new Event('selectionchange'));
    return true;
  })()`);
  await waitFor(cdp.send, `Boolean(document.querySelector('.table-context-toolbar'))`, "the contextual table toolbar");
  await evaluate(cdp.send, `document.querySelector('button[aria-label="在下方添加行"]')?.click()`);
  await waitFor(cdp.send, `document.querySelector('.rich-note-prosemirror table')?.rows.length === 5`, "an added table row");
  await evaluate(cdp.send, `document.querySelector('button[aria-label="删除当前行"]')?.click()`);
  await waitFor(cdp.send, `document.querySelector('.rich-note-prosemirror table')?.rows.length === 4`, "a deleted table row");
  await evaluate(cdp.send, `document.querySelector('button[aria-label="在右侧添加列"]')?.click()`);
  await waitFor(cdp.send, `document.querySelector('.rich-note-prosemirror table tbody tr')?.cells.length === 5`, "an added table column");
  await evaluate(cdp.send, `document.querySelector('button[aria-label="删除当前列"]')?.click()`);
  await waitFor(cdp.send, `document.querySelector('.rich-note-prosemirror table tbody tr')?.cells.length === 4`, "a deleted table column");
  await evaluate(cdp.send, `document.querySelector('.table-context-toolbar button[aria-pressed]')?.click()`);
  await waitFor(cdp.send, `document.querySelectorAll('.rich-note-prosemirror table th').length === 0`, "the disabled table header");
  await evaluate(cdp.send, `document.querySelector('.table-context-toolbar button[aria-pressed]')?.click()`);
  await waitFor(cdp.send, `document.querySelectorAll('.rich-note-prosemirror table th').length === 4`, "the restored table header");

  const tablePersistence = await waitForValue(async () => {
    const persisted = JSON.parse(await fs.readFile(smokeStatePath, "utf8"));
    const findTable = (node) => {
      if (node?.type === "table") return node;
      for (const child of node?.content || []) {
        const table = findTable(child);
        if (table) return table;
      }
      return null;
    };
    const note = persisted.notes?.[richNoteId];
    const table = findTable(note?.richBody);
    if (!table) return null;
    return {
      rows: table.content.length,
      columns: table.content[0]?.content?.length || 0,
      firstCellType: table.content[0]?.content?.[0]?.type,
      markdownHasDelimiter: /\|\s*:?-{3}/.test(note.body),
    };
  }, "the editable table to reach disk");
  if (
    tablePersistence.rows !== 4
    || tablePersistence.columns !== 4
    || tablePersistence.firstCellType !== "tableHeader"
    || !tablePersistence.markdownHasDelimiter
  ) {
    throw new Error(`Unexpected persisted table: ${JSON.stringify(tablePersistence)}`);
  }

  await evaluate(cdp.send, "location.reload()");
  const reopenedPastedTable = await waitFor(
    cdp.send,
    `(() => {
      const table = document.querySelector('.rich-note-prosemirror table');
      if (!table || table.rows.length !== 4 || !table.textContent.includes('推荐调节变量')) return null;
      return { rows: table.rows.length, columns: table.rows[0]?.cells.length || 0 };
    })()`,
    "the pasted table after a renderer reload",
  );

  await evaluate(cdp.send, `document.querySelector('button[aria-label="新建笔记"]')?.click()`);
  await waitFor(
    cdp.send,
    `Boolean(document.querySelector('.rich-note-prosemirror[contenteditable="true"]')) && !document.querySelector('.rich-note-prosemirror table')`,
    "a blank note for the table grid",
  );
  await evaluate(cdp.send, `document.querySelector('button[aria-label="插入表格"]')?.click()`);
  await waitFor(cdp.send, `Boolean(document.querySelector('.table-grid-popover'))`, "the table size grid");
  await evaluate(cdp.send, `document.querySelector('.table-grid-picker button[aria-label="3 行 4 列"]')?.click()`);
  const gridTable = await waitFor(
    cdp.send,
    `(() => {
      const table = document.querySelector('.rich-note-prosemirror table');
      if (!table || table.rows.length !== 3 || table.rows[0]?.cells.length !== 4) return null;
      return {
        rows: table.rows.length,
        columns: table.rows[0].cells.length,
        headers: table.querySelectorAll('th').length,
      };
    })()`,
    "a table inserted from the size grid",
  );
  await evaluate(cdp.send, `(() => {
    const table = document.querySelector('.rich-note-prosemirror table');
    const paragraph = table?.rows[table.rows.length - 1]?.cells[table.rows[0].cells.length - 1]?.querySelector('p');
    const editor = document.querySelector('.rich-note-prosemirror');
    if (!paragraph || !editor) return false;
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    editor.focus();
    document.dispatchEvent(new Event('selectionchange'));
    editor.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab',
      code: 'Tab',
      bubbles: true,
      cancelable: true,
    }));
    return true;
  })()`);
  const tabAddedRow = await waitFor(
    cdp.send,
    `document.querySelector('.rich-note-prosemirror table')?.rows.length === 4`,
    "Tab to add a final table row",
  );
  const gridTablePersistence = await waitForValue(async () => {
    const persisted = JSON.parse(await fs.readFile(smokeStatePath, "utf8"));
    const note = persisted.notes?.[persisted.settings?.notesLastNoteId];
    const table = note?.richBody?.content?.find((node) => node.type === "table");
    if (!table || table.content.length !== 4) return null;
    return {
      noteId: note.id,
      rows: table.content.length,
      columns: table.content[0]?.content?.length || 0,
    };
  }, "the grid-created table to reach disk");
  await evaluate(cdp.send, "location.reload()");
  const reopenedGridTable = await waitFor(
    cdp.send,
    `(() => {
      const table = document.querySelector('.rich-note-prosemirror table');
      if (!table || table.rows.length !== 4 || table.rows[0]?.cells.length !== 4) return null;
      return { rows: table.rows.length, columns: table.rows[0].cells.length };
    })()`,
    "the grid-created table after a renderer reload",
  );

  if (cdp.exceptions.length) throw new Error(`Renderer exceptions: ${cdp.exceptions.join(" | ")}`);
  console.log(JSON.stringify({
    ok: true,
    todo,
    notes,
    maximizeResult,
    restoreResult,
    legacyMigration,
    legacyPersistence,
    rawTableMigration,
    rawTableMigrationPersistence,
    richEditor,
    basePlatformFonts,
    platformFonts,
    increasedFontSize,
    decreasedFontSize,
    lineHeightEditor,
    formulaEditor,
    pastedTable,
    tablePersistence,
    reopenedPastedTable,
    gridTable,
    tabAddedRow,
    gridTablePersistence,
    reopenedGridTable,
  }, null, 2));
} catch (error) {
  if (processOutput.trim()) console.error(processOutput.trim());
  throw error;
} finally {
  if (cdp) {
    try {
      await Promise.race([cdp.send("Browser.close"), delay(500)]);
    } catch {
      // The process may already be closing.
    }
    cdp.socket.close();
  }
  await Promise.race([once(child, "exit"), delay(5_000)]).catch(() => {});
  if (child.exitCode === null) child.kill();
  await delay(250);
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
