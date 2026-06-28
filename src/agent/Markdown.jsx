// 轻量 markdown 渲染（无第三方依赖）：支持 #-### 标题、**粗体**、`代码`、- 列表、1. 列表、段落。
// 够用即可——Claude 复盘输出主要就是这些元素。

function inline(text, keyBase) {
  const parts = [];
  const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let match;
  let i = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith("**")) parts.push(<strong key={`${keyBase}-b${i}`} className="font-semibold text-[#191622]">{token.slice(2, -2)}</strong>);
    else parts.push(<code key={`${keyBase}-c${i}`} className="rounded bg-[#f0edf6] px-1 text-[12px]">{token.slice(1, -1)}</code>);
    last = match.index + token.length;
    i += 1;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export default function Markdown({ text }) {
  if (!text) return null;
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let list = null; // { ordered, items }

  const flushList = () => {
    if (!list) return;
    blocks.push({ type: list.ordered ? "ol" : "ul", items: list.items });
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,4})\s+(.*)/);
    const ul = line.match(/^\s*[-*•]\s+(.*)/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (h) {
      flushList();
      blocks.push({ type: `h${h[1].length}`, text: h[2] });
    } else if (ul) {
      if (!list || list.ordered) { flushList(); list = { ordered: false, items: [] }; }
      list.items.push(ul[1]);
    } else if (ol) {
      if (!list || !list.ordered) { flushList(); list = { ordered: true, items: [] }; }
      list.items.push(ol[1]);
    } else if (!line.trim()) {
      flushList();
    } else {
      flushList();
      blocks.push({ type: "p", text: line });
    }
  }
  flushList();

  return (
    <div className="space-y-2.5 text-[13px] leading-relaxed text-[#3d3747]">
      {blocks.map((b, i) => {
        if (b.type === "h1" || b.type === "h2") return <h3 key={i} className="mt-4 border-b border-[#eeeaf3] pb-1 text-sm font-bold text-[#191622] first:mt-0">{inline(b.text, i)}</h3>;
        if (b.type === "h3" || b.type === "h4") return <h4 key={i} className="mt-3 text-[13px] font-semibold text-[#262231]">{inline(b.text, i)}</h4>;
        if (b.type === "ul") return <ul key={i} className="list-disc space-y-1 pl-5">{b.items.map((item, j) => <li key={j}>{inline(item, `${i}-${j}`)}</li>)}</ul>;
        if (b.type === "ol") return <ol key={i} className="list-decimal space-y-1 pl-5">{b.items.map((item, j) => <li key={j}>{inline(item, `${i}-${j}`)}</li>)}</ol>;
        return <p key={i}>{inline(b.text, i)}</p>;
      })}
    </div>
  );
}
