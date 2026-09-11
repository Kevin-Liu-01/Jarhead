// Tiny DOM helpers. No framework: we build nodes directly and reconcile by key
// where it matters (the console stream). Everything else re-renders wholesale
// behind a signature check, which is plenty at ≤ 20 Hz snapshots.

/**
 * h(tag, props?, ...children) → HTMLElement
 * props: class, style (object or string), dataset, on<Event> handlers,
 *        html (innerHTML), booleans become properties when the element has them,
 *        everything else becomes an attribute.
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === "class") el.className = value;
      else if (key === "style") {
        if (typeof value === "string") el.style.cssText = value;
        else Object.assign(el.style, value);
      } else if (key === "dataset") Object.assign(el.dataset, value);
      else if (key === "html") el.innerHTML = value;
      else if (key === "value") el.value = value;
      else if (key.startsWith("on") && typeof value === "function") {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (typeof value === "boolean") {
        if (key in el) el[key] = value;
        else el.toggleAttribute(key, value);
      } else el.setAttribute(key, String(value));
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

/** Inline SVG string → span.icon */
export function icon(svgString, className = "") {
  return h("span", { class: `icon ${className}`.trim(), html: svgString, "aria-hidden": "true" });
}

/** Chip with a status dot; `tone` is a CSS color expression. */
export function chip(label, tone, className = "") {
  return h("span", { class: `chip ${className}`.trim(), style: { "--chip": tone } }, label);
}

export function dot(tone, live = false) {
  return h("span", { class: `dot${live ? " live" : ""}`, style: { "--dot": tone } });
}

/** Coalesce many calls into a single run on the next animation frame. */
export function rafCoalesce(fn) {
  let scheduled = false;
  let latest;
  return (arg) => {
    latest = arg;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fn(latest);
    });
  };
}

/** Attach a toast stack to the document and return a `toast(text, tone)` fn. */
export function makeToaster(parent = document.body, { ttl = 2800 } = {}) {
  const stack = h("div", { class: "toast-stack", role: "status", "aria-live": "polite" });
  parent.append(stack);
  return (text, tone = "info") => {
    const node = h("div", { class: `toast ${tone}` }, text);
    stack.append(node);
    const gone = () => node.remove();
    setTimeout(() => {
      node.classList.add("out");
      node.addEventListener("animationend", gone, { once: true });
      setTimeout(gone, 400);
    }, ttl);
    return node;
  };
}

export const prefersReducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
