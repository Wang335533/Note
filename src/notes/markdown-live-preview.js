import { attachmentIdFromUrl } from "desktop-note/library-files";
import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";

class TextWidget extends WidgetType {
  constructor(text, className) {
    super();
    this.text = text;
    this.className = className;
  }

  eq(other) {
    return other.text === this.text && other.className === this.className;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = this.className;
    span.textContent = this.text;
    span.setAttribute("aria-hidden", "true");
    return span;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(checked, checkFrom) {
    super();
    this.checked = checked;
    this.checkFrom = checkFrom;
  }

  eq(other) {
    return other.checked === this.checked && other.checkFrom === this.checkFrom;
  }

  toDOM() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `cm-live-checkbox ${this.checked ? "is-checked" : ""}`;
    button.dataset.checkFrom = String(this.checkFrom);
    button.dataset.checked = String(this.checked);
    button.setAttribute("aria-label", this.checked ? "标记为未完成" : "标记为已完成");
    button.innerHTML = this.checked ? "<span>✓</span>" : "<span></span>";
    return button;
  }

  ignoreEvent() {
    return false;
  }
}

class RuleWidget extends WidgetType {
  toDOM() {
    const rule = document.createElement("span");
    rule.className = "cm-live-rule";
    rule.setAttribute("aria-hidden", "true");
    return rule;
  }
}

class ImageWidget extends WidgetType {
  constructor(alt, source, resolveAssetUrl) {
    super();
    this.alt = alt;
    this.source = source;
    this.resolveAssetUrl = resolveAssetUrl;
  }

  eq(other) {
    return other.alt === this.alt && other.source === this.source;
  }

  toDOM() {
    const figure = document.createElement("span");
    figure.className = "cm-live-image";
    const image = document.createElement("img");
    const attachmentId = attachmentIdFromUrl(this.source);
    image.src = attachmentId ? this.resolveAssetUrl?.(attachmentId) || this.source : this.source;
    image.alt = this.alt;
    image.draggable = false;
    image.addEventListener("error", () => figure.classList.add("is-missing"), { once: true });
    figure.append(image);
    if (this.alt) {
      const caption = document.createElement("span");
      caption.textContent = this.alt;
      figure.append(caption);
    }
    return figure;
  }
}

function blockAroundSelection(state) {
  const selection = state.selection.main;
  let first = state.doc.lineAt(selection.from).number;
  let last = state.doc.lineAt(selection.to).number;
  while (first > 1 && state.doc.line(first - 1).text.trim()) first -= 1;
  while (last < state.doc.lines && state.doc.line(last + 1).text.trim()) last += 1;
  return {
    from: state.doc.line(first).from,
    to: state.doc.line(last).to,
  };
}

function rangesOverlap(left, right) {
  return left.from < right.to && right.from < left.to;
}

function addInlinePreview(text, lineFrom, decorations, occupied) {
  const patterns = [
    {
      regexp: /\[([^\]]+)\]\(([^)]+)\)/g,
      content: (match) => ({ from: match.index + 1, to: match.index + 1 + match[1].length, className: "cm-live-link" }),
      markers: (match) => [
        { from: match.index, to: match.index + 1 },
        { from: match.index + 1 + match[1].length, to: match.index + match[0].length },
      ],
    },
    {
      regexp: /(\*\*|__)(\S(?:.*?\S)?)\1/g,
      content: (match) => ({ from: match.index + match[1].length, to: match.index + match[0].length - match[1].length, className: "cm-live-strong" }),
      markers: (match) => [
        { from: match.index, to: match.index + match[1].length },
        { from: match.index + match[0].length - match[1].length, to: match.index + match[0].length },
      ],
    },
    {
      regexp: /(?<![*_])([*_])(\S(?:.*?\S)?)\1(?![*_])/g,
      content: (match) => ({ from: match.index + 1, to: match.index + match[0].length - 1, className: "cm-live-emphasis" }),
      markers: (match) => [
        { from: match.index, to: match.index + 1 },
        { from: match.index + match[0].length - 1, to: match.index + match[0].length },
      ],
    },
    {
      regexp: /(`+)([^`\n]+?)\1/g,
      content: (match) => ({ from: match.index + match[1].length, to: match.index + match[0].length - match[1].length, className: "cm-live-code-inline" }),
      markers: (match) => [
        { from: match.index, to: match.index + match[1].length },
        { from: match.index + match[0].length - match[1].length, to: match.index + match[0].length },
      ],
    },
    {
      regexp: /~~(\S(?:.*?\S)?)~~/g,
      content: (match) => ({ from: match.index + 2, to: match.index + match[0].length - 2, className: "cm-live-strike" }),
      markers: (match) => [
        { from: match.index, to: match.index + 2 },
        { from: match.index + match[0].length - 2, to: match.index + match[0].length },
      ],
    },
  ];

  for (const pattern of patterns) {
    pattern.regexp.lastIndex = 0;
    for (const match of text.matchAll(pattern.regexp)) {
      const whole = { from: match.index, to: match.index + match[0].length };
      if (occupied.some((range) => rangesOverlap(range, whole))) continue;
      occupied.push(whole);
      const content = pattern.content(match);
      decorations.push(Decoration.mark({ class: content.className }).range(
        lineFrom + content.from,
        lineFrom + content.to,
      ));
      for (const marker of pattern.markers(match)) {
        decorations.push(Decoration.replace({}).range(lineFrom + marker.from, lineFrom + marker.to));
      }
    }
  }
}

function buildDecorations(view, resolveAssetUrl, renderAll) {
  const active = renderAll ? { from: -2, to: -2 } : blockAroundSelection(view.state);
  const decorations = [];
  let inCodeBlock = false;

  for (let lineNumber = 1; lineNumber <= view.state.doc.lines; lineNumber += 1) {
    const line = view.state.doc.line(lineNumber);
    const text = line.text;
    const trimmed = text.trim();
    const activeBlock = line.to >= active.from && line.from <= active.to;
    const lineClasses = [activeBlock ? "cm-live-active" : "cm-live-rendered"];
    const fence = text.match(/^\s*```/);
    const codeLine = inCodeBlock || Boolean(fence);
    if (codeLine) lineClasses.push("cm-live-code-line");

    const heading = text.match(/^\s*(#{1,6})\s+/);
    const quote = text.match(/^\s*>\s?/);
    const checkbox = text.match(/^(\s*)[-+*]\s+\[([ xX])\]\s+/);
    const bullet = !checkbox ? text.match(/^(\s*)[-+*]\s+/) : null;
    const numbered = text.match(/^(\s*)(\d+)[.)]\s+/);
    const rule = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(text);
    const image = text.match(/^\s*!\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)\s*$/);

    if (heading) lineClasses.push(`cm-live-heading cm-live-heading-${heading[1].length}`);
    else if (quote) lineClasses.push("cm-live-quote");
    else if (checkbox || bullet || numbered) lineClasses.push("cm-live-list-line");
    else if (trimmed && !codeLine) lineClasses.push("cm-live-paragraph");
    decorations.push(Decoration.line({ class: lineClasses.join(" ") }).range(line.from));

    if (!activeBlock && trimmed) {
      const occupied = [];
      if (fence) {
        decorations.push(Decoration.replace({
          widget: new TextWidget(inCodeBlock ? "代码结束" : "代码", "cm-live-code-label"),
        }).range(line.from, line.to));
        occupied.push({ from: 0, to: text.length });
      } else if (image) {
        decorations.push(Decoration.replace({
          widget: new ImageWidget(image[1], image[2] || image[3], resolveAssetUrl),
        }).range(line.from, line.to));
        occupied.push({ from: 0, to: text.length });
      } else if (rule) {
        decorations.push(Decoration.replace({ widget: new RuleWidget() }).range(line.from, line.to));
        occupied.push({ from: 0, to: text.length });
      } else if (heading) {
        decorations.push(Decoration.replace({}).range(line.from + heading.index, line.from + heading[0].length));
        occupied.push({ from: heading.index, to: heading[0].length });
      } else if (quote) {
        decorations.push(Decoration.replace({}).range(line.from + quote.index, line.from + quote[0].length));
        occupied.push({ from: quote.index, to: quote[0].length });
      } else if (checkbox) {
        const checkFrom = line.from + checkbox[1].length + 2;
        decorations.push(Decoration.replace({
          widget: new CheckboxWidget(checkbox[2].toLocaleLowerCase() === "x", checkFrom),
        }).range(line.from + checkbox[1].length, line.from + checkbox[0].length));
        occupied.push({ from: checkbox[1].length, to: checkbox[0].length });
      } else if (bullet) {
        decorations.push(Decoration.replace({
          widget: new TextWidget("•", "cm-live-bullet"),
        }).range(line.from + bullet[1].length, line.from + bullet[0].length));
        occupied.push({ from: bullet[1].length, to: bullet[0].length });
      } else if (numbered) {
        decorations.push(Decoration.replace({
          widget: new TextWidget(`${numbered[2]}.`, "cm-live-number"),
        }).range(line.from + numbered[1].length, line.from + numbered[0].length));
        occupied.push({ from: numbered[1].length, to: numbered[0].length });
      }
      if (!occupied.some((range) => range.from === 0 && range.to === text.length) && !codeLine) {
        addInlinePreview(text, line.from, decorations, occupied);
      }
    }

    if (fence) inCodeBlock = !inCodeBlock;
  }

  return Decoration.set(decorations, true);
}

export function livePreviewExtension(resolveAssetUrl, { renderAll = false } = {}) {
  const plugin = ViewPlugin.fromClass(class {
    constructor(view) {
      this.decorations = buildDecorations(view, resolveAssetUrl, renderAll);
    }

    update(update) {
      if (update.docChanged || update.selectionSet) {
        this.decorations = buildDecorations(update.view, resolveAssetUrl, renderAll);
      }
    }
  }, {
    decorations: (instance) => instance.decorations,
    eventHandlers: {
      mousedown(event, view) {
        const target = event.target.closest?.(".cm-live-checkbox");
        if (!target) return false;
        event.preventDefault();
        const from = Number(target.dataset.checkFrom);
        if (!Number.isInteger(from)) return false;
        view.dispatch({
          changes: {
            from,
            to: from + 3,
            insert: target.dataset.checked === "true" ? "[ ]" : "[x]",
          },
        });
        return true;
      },
    },
  });
  return plugin;
}
