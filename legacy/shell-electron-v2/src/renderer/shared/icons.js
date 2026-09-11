// Inline SVG icon strings. 24-unit grid, stroke-based, inherit currentColor.
// Rendered through dom.icon(); never emoji.

const wrap = (body, extra = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ${extra}>${body}</svg>`;

export const icons = {
  mic: wrap(
    '<path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 1 1-6 0V6a3 3 0 0 1 3-3z"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><path d="M12 18v3"/>',
  ),
  micOff: wrap(
    '<path d="M15 9.5V6a3 3 0 0 0-5.6-1.5"/><path d="M9 9v3a3 3 0 0 0 5.1 2.1"/><path d="M5.5 11.5a6.5 6.5 0 0 0 10.9 4.8"/><path d="M18.5 11.5c0 .8-.1 1.5-.4 2.2"/><path d="M12 18v3"/><path d="M4 4l16 16"/>',
  ),
  stop: wrap('<rect x="6" y="6" width="12" height="12" rx="2"/>'),
  console: wrap('<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7 9.5l3 2.5-3 2.5"/><path d="M12.5 14.5H17"/>'),
  moon: wrap('<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>'),
  bolt: wrap('<path d="M13 2.5L4.5 13.5H11l-1 8 8.5-11H12l1-8z"/>'),
  refresh: wrap('<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 3.5v5h-5"/>'),
  send: wrap('<path d="M21 3L10.5 13.5"/><path d="M21 3l-6.5 18-4-7.5L3 9.5 21 3z"/>'),
  x: wrap('<path d="M18 6L6 18M6 6l12 12"/>'),
  chevronDown: wrap('<path d="M6 9l6 6 6-6"/>'),
  chevronRight: wrap('<path d="M9 6l6 6-6 6"/>'),
  arrowDown: wrap('<path d="M12 5v14"/><path d="M5.5 12.5L12 19l6.5-6.5"/>'),
  alert: wrap(
    '<path d="M12 9.5v4"/><path d="M12 17h.01"/><path d="M10.3 3.9L1.9 18.2A2 2 0 0 0 3.6 21.2h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  ),
  check: wrap('<path d="M20 6.5L9 17.5l-5-5"/>'),
  image: wrap('<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.5" cy="9" r="1.5"/><path d="M21 15.5l-4.5-4.5L6 21"/>'),
  tool: wrap('<path d="M4.5 17.5l6-5.5-6-5.5"/><path d="M12.5 19h7"/>'),
  external: wrap('<path d="M18 13.5v5a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"/><path d="M15 3.5h5.5V9"/><path d="M10.5 13.5l10-10"/>'),
  thinking: wrap('<circle cx="6" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.2" fill="currentColor" stroke="none"/>'),
  speaker: wrap('<path d="M11 5.5L6.5 9H3v6h3.5L11 18.5v-13z"/><path d="M15 9a4.2 4.2 0 0 1 0 6"/><path d="M17.8 6.5a8 8 0 0 1 0 11"/>'),
  confirm: wrap('<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.6a2.5 2.5 0 1 1 3.6 2.3c-.8.4-1.2 1-1.2 1.8"/><path d="M12 17h.01"/>'),
  note: wrap('<path d="M4.5 7h15"/><path d="M4.5 12h15"/><path d="M4.5 17h9"/>'),
  clock: wrap('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5l3 2"/>'),
  cursor: wrap('<path d="M5.5 3.5l14 8-6 2.2-2.6 5.8z"/>'),
  ledger: wrap('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2.5H20v19H6.5A2.5 2.5 0 0 1 4 19V5a2.5 2.5 0 0 1 2.5-2.5z"/>'),
  key: wrap('<circle cx="8" cy="15.5" r="4"/><path d="M10.8 12.7L20.5 3"/><path d="M15 5.5l3 3"/><path d="M17.5 3l3 3"/>'),
  plus: wrap('<path d="M12 5v14"/><path d="M5 12h14"/>'),
  brain: wrap('<path d="M9.5 3.5a3 3 0 0 0-3 3v.5a3 3 0 0 0-2 5 3 3 0 0 0 1.5 5.5 3 3 0 0 0 5.5 1.5V6.5a3 3 0 0 0-2-3z"/><path d="M14.5 3.5a3 3 0 0 1 3 3v.5a3 3 0 0 1 2 5 3 3 0 0 1-1.5 5.5 3 3 0 0 1-5.5 1.5V6.5a3 3 0 0 1 2-3z"/>'),
  hand: wrap('<path d="M8 12.5V6a1.5 1.5 0 0 1 3 0v5"/><path d="M11 11V4.5a1.5 1.5 0 0 1 3 0V11"/><path d="M14 11V6a1.5 1.5 0 0 1 3 0v7.5"/><path d="M17 13.5a1.5 1.5 0 0 1 3 0v2A5.5 5.5 0 0 1 14.5 21h-2.3a5 5 0 0 1-4-2l-3.4-4.6a1.5 1.5 0 0 1 2.4-1.8L8 14"/>'),
  eye: wrap('<path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>'),
  ban: wrap('<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>'),
  zap: wrap('<path d="M13 2.5L4.5 13.5H11l-1 8 8.5-11H12l1-8z"/>'),
  minus: wrap('<path d="M5 12h14"/>'),
};

export const stepIcon = {
  thinking: icons.thinking,
  commentary: icons.speaker,
  tool: icons.tool,
  screenshot: icons.image,
  confirm: icons.confirm,
  note: icons.note,
  error: icons.alert,
};
