function decodeXmlEntities(text) {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

export function parseXml(xml) {
  const root = {
    name: "__root__",
    children: [],
    text: "",
  };
  const stack = [root];
  const tokenPattern =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[^>]+>|[^<]+/g;

  for (const token of xml.match(tokenPattern) || []) {
    if (!token) {
      continue;
    }

    if (token.startsWith("<?") || token.startsWith("<!--")) {
      continue;
    }

    if (token.startsWith("<![CDATA[")) {
      const text = token.slice(9, -3);
      stack[stack.length - 1].text += text;
      continue;
    }

    if (token.startsWith("</")) {
      if (stack.length > 1) {
        stack.pop();
      }
      continue;
    }

    if (token.startsWith("<")) {
      const selfClosing = token.endsWith("/>");
      const inner = token.slice(1, selfClosing ? -2 : -1).trim();
      if (!inner || inner.startsWith("!")) {
        continue;
      }

      const name = inner.split(/\s+/, 1)[0];
      const node = {
        name,
        children: [],
        text: "",
      };
      stack[stack.length - 1].children.push(node);
      if (!selfClosing) {
        stack.push(node);
      }
      continue;
    }

    const text = decodeXmlEntities(token).trim();
    if (text) {
      stack[stack.length - 1].text += text;
    }
  }

  return root;
}

export function childrenNamed(node, name) {
  return (node?.children || []).filter((child) => child.name === name);
}

export function firstChildNamed(node, name) {
  return childrenNamed(node, name)[0] || null;
}

export function firstText(node, path) {
  const parts = Array.isArray(path) ? path : [path];
  let current = node;

  for (const part of parts) {
    current = firstChildNamed(current, part);
    if (!current) {
      return "";
    }
  }

  return current.text || "";
}

export function allTexts(node, path) {
  const parts = Array.isArray(path) ? path : [path];
  if (parts.length === 0) {
    return [];
  }

  const [head, ...rest] = parts;
  const matches = childrenNamed(node, head);
  if (rest.length === 0) {
    return matches.map((match) => match.text || "");
  }

  return matches.flatMap((match) => allTexts(match, rest));
}
