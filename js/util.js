/** Small DOM + formatting helpers shared by the pages. */

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(node.style, value);
    } else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function seconds(value) {
  const total = Math.round(Number(value) || 0);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Distinct labels in listed order -- objects often repeat a category. */
export function uniqueLabels(objects = []) {
  const seen = new Set();
  const out = [];
  for (const obj of objects) {
    if (seen.has(obj.label)) continue;
    seen.add(obj.label);
    out.push(obj);
  }
  return out;
}

export function statusMessage(container, title, detail) {
  clear(container).append(
    el('div', { class: 'status' },
      el('p', { class: 'status-title', text: title }),
      detail ? el('p', { class: 'status-detail', text: detail }) : null),
  );
}
