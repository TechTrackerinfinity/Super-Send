'use strict';



// Measure only byte progress observed in this window, using a monotonic clock.
// Historical entries have no timing evidence and deliberately get no speed.
class TransferRateMeter {
  constructor(clock = () => performance.now()) { this.clock = clock; this.records = new Map(); }

  observe(transfers) {
    const now = this.clock();
    const visible = new Set();
    for (const transfer of transfers) {
      const id = transfer.id;
      visible.add(id);
      if (transfer.status === 'waiting') { this.records.delete(id); continue; }
      const value = Number(transfer.transferred);
      const count = Number.isFinite(value) && value >= 0 ? value : 0;
      let record = this.records.get(id);
      if (transfer.status === 'transferring' && (!record || count < record.bytes)) {
        record = { start: now, baseline: count, bytes: count, status: transfer.status, samples: [{ time: now, bytes: count }] };
        this.records.set(id, record);
      }
      if (!record || record.end !== undefined) continue;
      record.bytes = count;
      record.status = transfer.status;
      if (record.samples.at(-1).time === now) record.samples.at(-1).bytes = count;
      else record.samples.push({ time: now, bytes: count });
      this.trim(record, now);
      if (transfer.status !== 'transferring') record.end = now;
    }
    for (const id of this.records.keys()) if (!visible.has(id)) this.records.delete(id);
  }

  trim(record, now) {
    // Retain one sample before the two-second window for a stable rolling rate.
    while (record.samples.length > 1 && record.samples[1].time <= now - 2000) record.samples.shift();
  }

  read(id) {
    const record = this.records.get(id);
    if (!record) return null;
    const now = record.end ?? this.clock();
    this.trim(record, now);
    const sample = record.samples[0];
    const elapsed = Math.max(0, now - record.start);
    const observedBytes = Math.max(0, record.bytes - record.baseline);
    const recentElapsed = Math.max(0, now - sample.time);
    // Avoid unstable rates from a single sample or an effectively instant file.
    return {
      status: record.status,
      bytesPerSecond: recentElapsed >= 250 ? Math.max(0, record.bytes - sample.bytes) * 1000 / recentElapsed : null,
      averageBytesPerSecond: elapsed >= 250 ? observedBytes * 1000 / elapsed : null,
      elapsedMs: elapsed,
      observedBytes,
    };
  }
}

const formatTransferSpeed = value => Number.isFinite(value) && value >= 0
  ? `${(value / 1000000).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB/s`
  : 'Measuring…';

if (typeof module !== 'undefined' && module.exports) module.exports = { TransferRateMeter, formatTransferSpeed };

if (typeof window !== 'undefined') (() => {

  const api = window.localSend;

  const ui = { page: 'receive', modal: null, filter: 'all', search: '', expanded: new Set(), busy: new Set(), scanning: false, aliasDraft: null, downloadDraft: null };

  let state = null;

  let dragDepth = 0;

  let toastId = 0;

  const transferRates = new TransferRateMeter();
  const speedExplanation = 'Measured from transfer byte progress observed in this window. Approval waiting time is excluded. 1 MB = 1,000,000 bytes.';

  const $ = (id) => document.getElementById(id);

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const paths = {

    receive: '<path d="M12 3v12m-4-4 4 4 4-4"/><path d="M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>',

    send: '<path d="M12 17V3m-4 4 4-4 4 4"/><path d="M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>',

    history: '<path d="M3 11a9 9 0 1 1 2.4 7.1M3 4v7h7"/><path d="M12 7v5l3 2"/>',

    settings: '<path d="m10 3-.6 2.1-2 .8-1.9-1L3.4 8.5l1.5 1.7-.2 2.1-1.6 1.6 2.3 3.8 2.1-.6 1.9 1 .4 2.2h4.4l.6-2.2 2-.8 1.8 1 2.2-3.8-1.5-1.6.2-2.2 1.6-1.5-2.2-3.8-2.2.6-1.9-1-.5-2.1Z"/><circle cx="12" cy="12" r="3"/>',

    laptop: '<rect x="4" y="4" width="16" height="12" rx="1.5"/><path d="M2 20h20l-2-4H4l-2 4Zm7 0 1-2h4l1 2"/>',

    desktop: '<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8m-4-5v5"/>',

    smartphone: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M10 5h4m-3 14h2"/>',

    tablet: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M11 19h2"/>',

    files: '<path d="M13 3H5a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V10l-7-7Zm0 0v7h7"/><path d="M8 14h8m-8 3h5"/>',

    folder: '<path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z"/>',

    text: '<path d="M4 5h16M12 5v15m-4 0h8M4 9V5m16 4V5"/>',

    clipboard: '<rect x="5" y="4" width="14" height="17" rx="2"/><rect x="9" y="2" width="6" height="4" rx="1"/><path d="M9 11h6m-6 4h6"/>',

    check: '<path d="m5 12 4 4L19 6"/>', close: '<path d="m6 6 12 12M6 18 18 6"/>',

    edit: '<path d="m15 4 5 5M4 20l5-1L21 7a1.4 1.4 0 0 0 0-2l-2-2a1.4 1.4 0 0 0-2 0L5 15l-1 5Z"/>',

    arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>', chevron: '<path d="m9 5 7 7-7 7"/>', down: '<path d="m6 9 6 6 6-6"/>',

    add: '<path d="M12 5v14M5 12h14"/>', refresh: '<path d="M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5m-4 8a8 8 0 0 0 14 3l3-3m0 5v-5h-5"/>',

    wifi: '<path d="M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0m-11 4a6 6 0 0 1 8 0"/><circle cx="12" cy="20" r=".7" fill="currentColor"/>',

    link: '<path d="m9 15 6-6m-7 3-2 2a4 4 0 0 0 6 6l3-3m1-5 2-2a4 4 0 0 0-6-6L9 7"/>',

    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',

    moon: '<path d="M20 14A8.5 8.5 0 0 1 10 4a8.5 8.5 0 1 0 10 10Z"/>',

    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3"/>',

    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/>',

    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',

    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',

    inbox: '<path d="M3 13 6 4h12l3 9v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6Zm0 0h5l2 3h4l2-3h5"/>',

    warning: '<path d="m12 3 10 17H2L12 3Z"/><path d="M12 9v5m0 3v.1"/>',

    external: '<path d="M13 4h7v7m0-7L10 14m-1-9H5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-4"/>',

    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-5 5 6"/>',

    stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',

  };

  const icon = (name, className = '') => `<svg viewBox="0 0 24 24" aria-hidden="true"${className ? ` class="${esc(className)}"` : ''}>${paths[name] || paths.files}</svg>`;

  const disabled = (key) => ui.busy.has(key) ? 'disabled' : '';

  const isActive = (transfer) => ['waiting', 'transferring'].includes(transfer.status);

  const bytes = (value) => {

    const number = Number(value) || 0;

    if (!number) return '0 B';

    const order = Math.min(Math.floor(Math.log(Math.abs(number)) / Math.log(1024)), 4);

    return `${(number / (1024 ** order)).toLocaleString(undefined, { maximumFractionDigits: order > 1 ? 1 : 0 })} ${['B', 'KB', 'MB', 'GB', 'TB'][order]}`;

  };

  const fileCount = (count) => `${count} ${count === 1 ? 'item' : 'items'}`;

  const deviceIcon = (type = '') => /phone|mobile/i.test(type) ? 'smartphone' : /tablet/i.test(type) ? 'tablet' : /desktop/i.test(type) ? 'desktop' : 'laptop';

  const fileIcon = (file) => file.type === 'text' || file.text !== undefined || /text\//.test(file.fileType || '') ? 'text' : /\.(png|jpg|jpeg|webp|gif|svg|heic|avif)$/i.test(file.name || file.fileName || '') ? 'image' : 'files';

  const transferPeer = (transfer) => typeof transfer.peer === 'string' ? transfer.peer : transfer.peer?.alias || 'Nearby device';

  const transferTime = (transfer) => new Date(transfer.createdAt || 0);

  function transfers() {

    const map = new Map();

    for (const transfer of [...(state?.history || []), ...(state?.transfers || [])]) map.set(transfer.id, transfer);

    return [...map.values()].sort((a, b) => transferTime(b) - transferTime(a));

  }

  function statusText(transfer) {

    return { waiting: 'Waiting for approval', transferring: transfer.direction === 'send' ? 'Sending' : 'Receiving', completed: 'Completed', rejected: 'Declined', failed: 'Transfer failed', cancelled: 'Cancelled' }[transfer.status] || transfer.status;

  }

  function relativeTime(transfer) {

    const date = transferTime(transfer);

    if (!Number.isFinite(date.getTime()) || date.getTime() === 0) return '';

    const elapsed = Math.max(0, Date.now() - date.getTime());

    if (elapsed < 60000) return 'Just now';

    if (elapsed < 3600000) return `${Math.floor(elapsed / 60000)}m ago`;

    if (elapsed < 86400000) return `${Math.floor(elapsed / 3600000)}h ago`;

    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  }

  const sumSize = (files = []) => files.reduce((total, file) => total + (Number(file.size) || 0), 0);



  // Update existing nodes so progress does not replace focused controls or scrollable lists.

  function nodeKey(node) {

    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    if (node.id) return `id:${node.id}`;

    const data = node.dataset;

    return data.action ? `${node.tagName}:${data.action}:${data.id || data.page || ''}:${data.accept || ''}` : '';

  }

  function patchNode(current, next) {

    if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) {

      current.replaceWith(next.cloneNode(true)); return;

    }

    if (current.nodeType === Node.TEXT_NODE) {

      if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;

      return;

    }

    if (current.nodeType !== Node.ELEMENT_NODE) return;

    for (const attribute of [...current.attributes]) if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);

    for (const attribute of [...next.attributes]) if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);

    patchChildren(current, next);

    if(current.tagName==='INPUT'&&current.type==='checkbox')current.checked=next.checked;

    if (current !== document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(current.tagName) && current.value !== next.value) current.value = next.value;

  }

  function patchChildren(current, next) {

    const remaining = [...current.childNodes];

    const ordered = [];

    for (const desired of [...next.childNodes]) {

      const key = nodeKey(desired);

      const match = remaining.find(node => node.nodeType === desired.nodeType && node.nodeName === desired.nodeName && (key ? nodeKey(node) === key : !nodeKey(node)));

      if (match) {

        remaining.splice(remaining.indexOf(match), 1);

        patchNode(match, desired); ordered.push(match);

      } else ordered.push(desired.cloneNode(true));

    }

    for (const node of remaining) node.remove();

    ordered.forEach((node, index) => { if (current.childNodes[index] !== node) current.insertBefore(node, current.childNodes[index] || null); });

  }

  function patchMarkup(element, markup) {

    const template = document.createElement('template'); template.innerHTML = markup;

    patchChildren(element, template.content);

  }



  function toast(message, error = false) {

    const id = ++toastId;

    const node = document.createElement('div');

    node.className = `toast${error ? ' error' : ''}`;

    node.id = `toast-${id}`;

    node.setAttribute('role', error ? 'alert' : 'status');

    node.innerHTML = `${icon(error ? 'warning' : 'check')}<span>${esc(message)}</span><button aria-label="Dismiss notification" data-action="dismiss-toast" data-id="${id}">${icon('close')}</button>`;

    $('toast-root').appendChild(node);

    while ($('toast-root').children.length > 3) $('toast-root').firstElementChild.remove();

    window.setTimeout(() => node.remove(), error ? 7500 : 4000);

  }



  async function command(key, callback, success, shouldSync = true) {

    if (ui.busy.has(key)) return undefined;

    ui.busy.add(key);

    render();

    try {

      const result = await callback();

      if (shouldSync) {

        const next = result?.device && result?.settings ? result : await api.getState();

        applyState(next);

      }

      if (success) toast(success);

      return result ?? true;

    } catch (error) {

      const message = error?.message || String(error);

      toast(message, true);

      return undefined;

    } finally {

      ui.busy.delete(key);

      render();

    }

  }



  function applyState(next) {

    if (!next || !next.device) return;

    state = { ...next, peers: next.peers || [], selection: next.selection || [], transfers: next.transfers || [], requests: next.requests || [], history: next.history || [], network: next.network || {} };

    transferRates.observe(transfers());

    applyTheme();

    render();

  }

  function applyTheme() {

    const preference = state?.settings?.theme || 'light';

    const dark = preference === 'dark' || (preference === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

    document.documentElement.dataset.theme = dark ? 'dark' : 'light';

  }

  function keepFocus(callback) {

    const active = document.activeElement;

    const id = active?.id;

    const start = active?.selectionStart;

    const end = active?.selectionEnd;

    const previousModal = $('modal-root').firstElementChild?.dataset.modal;

    callback();

    const currentModal = $('modal-root').firstElementChild?.dataset.modal;

    $('app').inert = !!currentModal;

    $('toast-root').hidden = !!currentModal;

    if (currentModal && !previousModal) ui.returnFocus = active;

    if (currentModal !== previousModal && currentModal) {

      const dialog = $('modal-root').querySelector('[role="dialog"]');

      dialog.setAttribute('tabindex', '-1');

      const focus = currentModal.startsWith('request:') ? dialog : dialog.querySelector('[autofocus]') || dialog.querySelector('input, textarea, button');

      focus?.focus({ preventScroll: true });

    } else if (!currentModal && previousModal) {

      if (ui.returnFocus?.isConnected) ui.returnFocus.focus({ preventScroll: true });

      ui.returnFocus = null;

    } else if (id && $(id) && document.activeElement !== $(id)) {

      $(id).focus({ preventScroll: true });

      if (typeof start === 'number' && typeof $(id).setSelectionRange === 'function') {

        try { $(id).setSelectionRange(start, end); } catch (_) { /* Number inputs do not expose selection. */ }

      }

    }

  }

  function render() {

    if (!state) return;

    keepFocus(() => {

      renderNavigation();

      const networkReady = state.network.ready;

      $('network-status').className = `network-status${networkReady ? '' : ' offline'}`;

      const accessLabel=state.network.reverseReady?'Phone connected - ready to receive':'Ready to connect';

      patchMarkup($('network-status'), `<span class="status-dot"></span>${networkReady ? accessLabel : 'Receiver unavailable'}`);

      $('network-status').title = state.network.error || state.network.notice || 'Devices on the same network can find you.';

      $('footer-device').textContent = `${state.device.alias} · ${state.device.deviceModel || 'This device'}`;

      patchMarkup($('footer-protocol'), `${icon(state.device.protocol === 'http' ? 'wifi' : 'lock')}${esc((state.device.protocol || 'https').toUpperCase())} · ${esc(state.device.port)}`);

      const banner = state.network.error || state.network.notice;

      patchMarkup($('page'), `${banner ? `<div class="network-notice${state.network.error ? ' error' : ''}">${icon(state.network.error ? 'warning' : 'info')}<span>${esc(banner)}</span></div>` : ''}${{ receive: renderReceive, send: renderSend, history: renderHistory, settings: renderSettings }[ui.page]()}`);

      renderModal();

    });

  }

  function renderNavigation() {

    const activeCount = transfers().filter(isActive).length;

    patchMarkup($('navigation'), [['receive', 'Receive'], ['send', 'Send'], ['history', 'History'], ['settings', 'Settings']].map(([id, title]) => `<button class="nav-item${ui.page === id ? ' active' : ''}" data-action="navigate" data-page="${id}" aria-label="${title}"${ui.page === id ? ' aria-current="page"' : ''}><span class="nav-icon">${icon(id)}${id === 'history' && activeCount ? `<span class="nav-badge">${activeCount}</span>` : ''}</span><span>${title}</span></button>`).join(''));

  }



  function renderReceive() {

    const recent = transfers().filter((transfer) => !isActive(transfer)).slice(0, 3);

    const address = state.device.addresses?.[0];

    const secure = state.device.protocol !== 'http';

    return `<div class="page-heading"><div><h1>Receive</h1><p>Your next transfer starts here.</p></div><button class="button outline" data-action="open-downloads">${icon('folder')}Open downloads</button></div>

      ${renderConnection()}<div class="receive-layout"><div class="receive-main">

        <section class="surface receive-hero" aria-label="This device">

          <div class="hero-topline"><span class="eyebrow">THIS DEVICE</span><span class="hero-status"><span class="status-dot"></span>${state.network.ready ? (state.network.reverseReady?'Phone connected':'Ready to connect') : 'Waiting for network'}</span></div>

          <div class="hero-content"><div class="train-hero-art"><img src="assets/logo.png" alt="Super Send bullet train"><span class="train-caption">READY FOR DEPARTURE</span></div><div class="device-summary">

          <h2 class="hero-alias">${esc(state.device.alias)}</h2>

          <div class="device-model">${esc(state.device.deviceModel || 'Windows')}<span class="mini-separator"></span><button class="text-button" style="font-size:10px;font-weight:500" data-action="rename">Rename</button></div>

          <p class="hero-description">Open Super Send on your phone.<br>Choose <strong>${esc(state.device.alias)}</strong> to share something with you.</p>

          ${address ? `<button class="device-address" data-action="copy-address" title="Copy local IP address">${icon('wifi')}${esc(address)}${icon('copy')}</button>` : '<div class="device-address">No local address available</div>'}</div></div>

        </section>

        <div><section class="surface download-card"><div class="soft-icon teal">${icon('folder')}</div><div class="download-info"><div class="download-label">Files are saved to</div><button class="path-button" data-action="open-downloads" title="${esc(state.settings.downloadDir)}"><span>${esc(state.settings.downloadDir || 'Downloads')}</span>${icon('external')}</button></div><button class="icon-button" data-action="choose-downloads" aria-label="Change download folder" title="Change download folder" ${disabled('choose-downloads')}>${icon('edit')}</button></section>

        <div class="quick-save"><div><div class="quick-save-title">Quick save ${icon('info')}</div><p>Automatically accept incoming transfers.</p></div><button class="toggle" role="switch" aria-label="Quick save" aria-checked="${!!state.settings.autoAccept}" data-action="toggle-accept" ${disabled('auto-accept')}></button></div></div>

      </div><aside class="receive-side"><section class="surface activity-panel"><div class="section-heading"><h2>Recent activity</h2>${recent.length ? '<button class="text-button" data-action="navigate" data-page="history">View all</button>' : icon('history')}</div>

      ${recent.length ? `<div class="activity-list">${recent.map((transfer) => `<button class="activity-item" data-action="view-transfer" data-id="${esc(transfer.id)}"><div class="transfer-icon ${esc(transfer.status)}">${icon(transfer.direction === 'send' ? 'send' : 'receive')}</div><div class="transfer-heading"><div class="transfer-title">${esc(transfer.files?.[0]?.name || transfer.files?.[0]?.fileName || fileCount(transfer.files?.length || 0))}</div><div class="transfer-subtitle">${esc(transferPeer(transfer))}<span class="mini-separator"></span>${relativeTime(transfer)}</div></div></button>`).join('')}</div>` : `<div class="activity-empty"><div class="empty-orbit">${icon('inbox')}</div><h3>No transfers yet</h3><p>Your sent and received files will appear here. Ready when you are.</p></div>`}</section>

      <div class="help-card">${icon('wifi')}<div><h3>On the same network?</h3><p>Connect your devices to the same Wi-Fi or local network, then keep Super Send open on both.</p></div></div></aside></div>

      ${renderActiveTransfers()}<div class="security-note">${icon(secure ? 'lock' : 'wifi')}${secure ? 'Encrypted transfers. No cloud. Just your devices.' : 'Direct sharing between your devices on your local network.'}</div>`;

  }



  function renderSend() {

    const total = sumSize(state.selection);

    return `<div class="page-heading"><div><h1>Send</h1><p>Pick your files. Choose a device. Send.</p></div><button class="button outline" data-action="manual">${icon('add')}Add device</button></div>

    <div class="send-layout"><div><section class="surface selection-panel"><div class="panel-heading"><h2>Selection${state.selection.length ? `<span class="count-tag">${state.selection.length}</span>` : ''}</h2>${state.selection.length ? `<button class="text-button" data-action="clear-selection" ${disabled('clear-selection')}>Clear all</button>` : '<span class="eyebrow" style="font-size:8px;letter-spacing:1.3px">01 &nbsp; CHOOSE</span>'}</div>

    <div class="selection-actions">${[['files', 'Files', 'select-files'], ['folder', 'Folder', 'select-folder'], ['text', 'Text', 'text'], ['clipboard', 'Paste', 'paste']].map(([glyph, label, action]) => `<button class="selection-action" data-action="${action}" ${disabled(action)}>${icon(glyph)}<span>${label}</span></button>`).join('')}</div>

    ${state.selection.length ? `<div class="selected-files">${state.selection.map((file) => `<div class="file-row"><div class="file-icon">${icon(fileIcon(file))}</div><div class="file-details"><div class="file-name" title="${esc(file.name)}">${file.type === 'text' ? `<button class="text-file-name" data-action="preview-selection" data-id="${esc(file.id)}">${esc(file.name)}</button>` : esc(file.name)}</div><div class="file-meta">${bytes(file.size)}<span class="mini-separator"></span>${file.type === 'text' ? 'Text message' : 'File'}</div></div><button class="icon-button danger" data-action="remove-selection" data-id="${esc(file.id)}" title="Remove ${esc(file.name)}" aria-label="Remove ${esc(file.name)}">${icon('close')}</button></div>`).join('')}</div>` : `<button class="drop-zone" data-action="select-files" style="width:calc(100% - 40px)"><div class="empty-orbit">${icon('files')}</div><h3>Drop your files here</h3><p>Or choose files, a folder, or a little note.<br>Everything is shared directly.</p></button>`}

    <div class="selection-footer"><span>${state.selection.length ? `<strong>${fileCount(state.selection.length)}</strong> · ${bytes(total)}` : 'No files selected'}</span><span>Choose a device to send ${icon('arrow')}</span></div></section>

    <div class="selection-hint">${icon('lock')}<span>Your files travel directly to the device you choose. They never leave your local network.</span></div></div>

    <section class="surface nearby-panel"><div class="section-heading nearby-top"><div class="nearby-title"><h2>Nearby devices</h2>${state.peers.length ? `<span class="count-tag">${state.peers.length}</span>` : ''}</div><button class="icon-button teal" data-action="discover" title="Refresh nearby devices" aria-label="Refresh nearby devices" ${disabled('discover')}>${icon('refresh', ui.scanning ? 'spinning' : '')}</button></div><p class="nearby-subtitle">${state.selection.length ? 'Choose a device to send your selection.' : 'Choose something to share, then pick a device.'}</p>

    ${state.peers.length ? `<div class="peer-list">${state.peers.map((peer) => `<button class="peer-card" data-action="send" data-id="${esc(peer.id)}" title="Send to ${esc(peer.alias)}" ${disabled(`send:${peer.id}`)}><div class="soft-icon">${icon(deviceIcon(peer.deviceType))}</div><div><div class="peer-name">${esc(peer.alias)}</div><div class="peer-meta">${esc(peer.deviceModel || peer.deviceType || peer.host)}</div></div>${icon('arrow', 'peer-arrow')}</button>`).join('')}</div>` : `<div class="nearby-empty"><div class="radar"><span class="radar-dot"></span>${icon('wifi')}</div><h3>${ui.scanning ? 'Looking for your devices…' : 'No devices found yet'}</h3><p>Open Super Send on another device<br>connected to the same Wi-Fi network.</p></div>`}

    <div class="manual-row"><button class="button quiet" data-action="manual">${icon('link')}Connect with an IP address</button></div></section></div>${renderActiveTransfers()}`;

  }



  function renderActiveTransfers() {

    const active = transfers().filter(isActive);

    if (!active.length) return '';

    return `<section class="transfer-section"><div class="section-heading"><h2>In progress<span class="count-tag">${active.length}</span></h2><button class="text-button" data-action="navigate" data-page="history">View activity</button></div>${active.map((transfer) => renderTransfer(transfer)).join('')}</section>`;

  }

  function renderTransfer(transfer) {

    const files = transfer.files || [];

    const active = isActive(transfer);

    const expanded = ui.expanded.has(transfer.id);

    const progress = transfer.status === 'completed' ? 100 : Math.max(0, Math.min(100, Number(transfer.progress) <= 1 ? Number(transfer.progress) * 100 : Number(transfer.progress) || 0));

    const total = Number(transfer.total) || sumSize(files);

    const transferred = Number(transfer.transferred) || 0;

    const title = `${transfer.direction === 'send' ? 'To' : 'From'} ${transferPeer(transfer)}`;

    const measured = transferRates.read(transfer.id);
    const average = transfer.status === 'completed' && measured?.observedBytes > 0 && measured.averageBytesPerSecond !== null
      ? `<span class="mini-separator"></span><span title="${esc(speedExplanation)}">${esc(formatTransferSpeed(measured.averageBytesPerSecond))} avg</span>` : '';
    const speed = transfer.status === 'transferring'
      ? ` · <span data-transfer-rate="${esc(transfer.id)}" title="${esc(speedExplanation)}">${esc(formatTransferSpeed(measured?.bytesPerSecond))}</span>` : '';

    return `<article class="transfer-card" id="transfer-${esc(transfer.id)}"><div class="transfer-summary"><div class="transfer-icon ${esc(transfer.status)}">${icon(transfer.direction === 'send' ? 'send' : 'receive')}</div><div class="transfer-heading"><div class="transfer-title">${esc(title)}</div><div class="transfer-subtitle">${fileCount(files.length)}<span class="mini-separator"></span>${bytes(total)}${!active ? `<span class="mini-separator"></span>${relativeTime(transfer)}${average}` : ''}</div></div>${active ? `<span class="transfer-percentage">${transfer.status === 'waiting' ? 'Waiting' : `${Math.round(progress)}%`}</span><button class="icon-button danger" data-action="cancel-transfer" data-id="${esc(transfer.id)}" title="Cancel transfer" aria-label="Cancel transfer" ${disabled(`cancel:${transfer.id}`)}>${icon('close')}</button>` : `<span class="status-label ${esc(transfer.status)}">${icon(transfer.status === 'completed' ? 'check' : 'close')}${esc(statusText(transfer))}</span>`}<button class="icon-button" data-action="expand-transfer" data-id="${esc(transfer.id)}" title="${expanded ? 'Hide' : 'Show'} files" aria-label="${expanded ? 'Hide' : 'Show'} files" aria-expanded="${expanded}">${icon(expanded ? 'down' : 'chevron')}</button></div>

    ${active ? `<div class="progress-bar${transfer.status === 'waiting' ? ' waiting' : ''}" role="progressbar" aria-label="Transfer progress" aria-valuemin="0" aria-valuemax="100"${transfer.status !== 'waiting' ? ` aria-valuenow="${Math.round(progress)}"` : ''}><span style="width:${progress}%"></span></div><div class="progress-caption"><span>${esc(statusText(transfer))}${speed}</span><span>${bytes(transferred)} / ${bytes(total)}</span></div>` : ''}

    ${transfer.error ? `<div class="transfer-error">${esc(transfer.error)}</div>` : ''}

    ${expanded ? `<div class="transfer-file-list">${files.map((file) => `<div class="file-row"><div class="file-icon">${icon(fileIcon(file))}</div><div class="file-details"><div class="file-name" title="${esc(file.name || file.fileName)}">${esc(file.name || file.fileName)}</div><div class="file-meta">${bytes(file.size)}${file.status ? ` · ${esc(file.status)}` : ''}</div></div>${file.text !== undefined ? `<button class="icon-button teal" data-action="preview-text" data-transfer="${esc(transfer.id)}" data-id="${esc(file.id)}" title="View text" aria-label="View text">${icon('text')}</button><button class="icon-button teal" data-action="copy-file-text" data-transfer="${esc(transfer.id)}" data-id="${esc(file.id)}" title="Copy text" aria-label="Copy text">${icon('copy')}</button>` : file.path && (file.status === 'completed' || transfer.status === 'completed') ? `<button class="icon-button teal" data-action="open-file" data-transfer="${esc(transfer.id)}" data-id="${esc(file.id)}" title="Open file" aria-label="Open file">${icon('external')}</button>` : ''}</div>`).join('')}</div>` : ''}</article>`;

  }



  function renderHistory() {

    const all = transfers();

    const term = ui.search.toLocaleLowerCase();

    const filtered = all.filter((transfer) => (ui.filter === 'all' || transfer.direction === ui.filter) && (!term || [transferPeer(transfer), ...(transfer.files || []).map((file) => file.name || file.fileName)].join(' ').toLocaleLowerCase().includes(term)));

    const groups = new Map();

    for (const transfer of filtered) {

      const date = transferTime(transfer);

      const now = new Date();

      const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());

      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      const delta = Math.round((today - day) / 86400000);

      const label = delta === 0 ? 'Today' : delta === 1 ? 'Yesterday' : Number.isFinite(date.getTime()) ? date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) : 'Earlier';

      if (!groups.has(label)) groups.set(label, []);

      groups.get(label).push(transfer);

    }

    return `<div class="page-heading"><div><h1>History</h1><p>Your files and messages, in one place.</p></div><button class="button outline" data-action="open-downloads">${icon('folder')}Open downloads</button></div>

    <div class="history-toolbar"><div class="segmented" role="group" aria-label="Filter transfers">${[['all', 'All'], ['receive', 'Received'], ['send', 'Sent']].map(([id, label]) => `<button class="segment${ui.filter === id ? ' active' : ''}" aria-pressed="${ui.filter === id}" data-action="filter" data-id="${id}">${label}</button>`).join('')}</div><label class="search-field">${icon('search')}<span class="visually-hidden">Search transfers</span><input id="history-search" type="search" placeholder="Find a file or device" value="${esc(ui.search)}" autocomplete="off"></label></div>

    ${!all.length ? `<section class="surface history-empty"><div class="empty-orbit">${icon('history')}</div><h2>No transfers yet</h2><p>Your shared files and messages will appear here after your first transfer.</p><button class="button secondary" data-action="navigate" data-page="send">${icon('send')}Send something</button></section>` : !filtered.length ? '<div class="surface empty-filter">No transfers match your search.</div>' : [...groups].map(([label, items]) => `<section class="history-group"><h2 class="date-label">${esc(label)}</h2>${items.map((transfer) => renderTransfer(transfer)).join('')}</section>`).join('')}`;

  }



  function renderConnection() {

    const ready=state.network.reverseReady;

    const phones=state.network.reversePeers||[];

    const names=phones.map(phone=>phone.alias).join(', ');

    return `<section class="surface connection-card${ready?' connected':''}" id="connection-card" aria-label="Phone connection"><div class="connection-main"><div class="connection-symbol">${icon(ready?'check':'link')}</div><div class="connection-copy"><span class="eyebrow">YOUR DEVICES. ONE CONNECTION.</span><h2>${ready?'Phone connected. You are good to go.':'Connect once. Share whenever.'}</h2><p>${ready?`${esc(names||'Your phone')} is ready. Choose files on your phone and approve them here.`:'Open Super Send on your phone. Connect from this PC to send and receive on the same Wi-Fi.'}</p></div><button class="button ${ready?'outline':'primary'}" data-action="connect-phone">${icon('link')}${ready?'Connect another phone':'Connect Android phone'}</button></div><div class="connection-benefits"><span>${icon('lock')}Encrypted transfers</span><span>${icon('wifi')}Your local network</span><span>${icon('check')}Approval stays in your control</span></div></section>`;

  }



  function renderSettings() {

    const theme = state.settings.theme || 'light';

    const addresses = state.device.addresses || [];

    return `<div class="page-heading"><div><h1>Settings</h1><p>Set up sharing your way.</p></div></div><div class="settings-layout"><div class="settings-column">${renderConnection()}

    <section class="surface settings-card"><div class="section-heading"><h2>${icon('laptop')}Your device</h2></div><div class="field"><label for="settings-alias">Device name</label><div class="input-action"><input id="settings-alias" maxlength="80" value="${esc(ui.aliasDraft ?? state.settings.alias ?? state.device.alias)}" autocomplete="off" spellcheck="false"><button class="button secondary" data-action="save-alias" ${disabled('save-alias')}>Save</button></div><p class="field-hint">This is how you appear to nearby devices.</p></div></section>

    <section class="surface settings-card"><div class="section-heading"><h2>${icon('receive')}Receiving</h2></div><div class="field"><label for="settings-downloads">Save received files to</label><div class="input-action"><input id="settings-downloads" value="${esc(ui.downloadDraft ?? state.settings.downloadDir)}" spellcheck="false"><button class="icon-button teal" data-action="choose-downloads" aria-label="Choose download folder" title="Choose download folder" ${disabled('choose-downloads')}>${icon('folder')}</button><button class="button secondary" data-action="save-downloads" ${disabled('save-downloads')}>Save</button></div></div><div class="setting-row"><div><div class="setting-label">Quick save</div><p class="setting-description">Automatically accept incoming files and messages.</p></div><button class="toggle" role="switch" aria-label="Quick save" aria-checked="${!!state.settings.autoAccept}" data-action="toggle-accept" ${disabled('auto-accept')}></button></div></section>

    <section class="surface settings-card"><div class="section-heading"><h2>${icon('sun')}Appearance</h2></div><div class="theme-options">${[['light', 'sun', 'Light'], ['dark', 'moon', 'Dark'], ['system', 'desktop', 'System']].map(([id, glyph, label]) => `<button class="theme-option${theme === id ? ' selected' : ''}" data-action="theme" data-id="${id}" aria-pressed="${theme === id}" ${disabled('theme')}>${icon(glyph)}${label}</button>`).join('')}</div></section>

    <section class="surface settings-card"><div class="setting-row"><div><div class="setting-label">Network details</div><p class="setting-description">Connection information for this device.</p></div><button class="toggle" role="switch" aria-label="Show network details" aria-checked="${!!state.settings.showAdvanced}" data-action="toggle-advanced" ${disabled('advanced')}></button></div>${state.settings.showAdvanced ? `<div class="network-details"><div class="info-row"><span>Local addresses</span><strong>${addresses.length ? addresses.map(esc).join('<br>') : 'Unavailable'}</strong></div><div class="info-row"><span>Protocol / port</span><strong>${esc((state.device.protocol || 'https').toUpperCase())} / ${esc(state.device.port)}</strong></div><div class="info-row"><span>Discovery multicast</span><strong>${esc(state.settings.multicast || '224.0.0.167')}</strong></div><div class="info-row"><span>Discovery</span><strong>${state.network.discovery ? 'Active' : 'Unavailable'}</strong></div><div class="info-row"><span>Fingerprint</span><button data-action="copy-fingerprint" title="Copy device fingerprint">${esc(state.device.fingerprint ? `${state.device.fingerprint.slice(0, 16)}…` : 'Unavailable')}${state.device.fingerprint ? ` ${icon('copy')}` : ''}</button></div></div>` : ''}</section>

    </div><aside class="settings-side"><section class="surface about-card"><img class="about-logo" src="assets/logo.png" alt=""><h2>Super Send</h2><div class="version">Desktop rebuild · ${esc(state.version || '1.6.0')}</div><p>Share files with nearby devices.<br>Simple, private, and right here.</p><div class="about-info"><div class="info-row"><span>This device</span><strong>${esc(state.device.alias)}</strong></div><div class="info-row"><span>Protocol version</span><strong>${esc(state.device.version || '2.2')}</strong></div><div class="info-row"><span>Connection</span><strong>${state.network.ready ? 'Local network' : 'Unavailable'}</strong></div></div><div class="about-lock">${icon('lock')}${state.device.protocol === 'http' ? 'Direct local transfers' : 'Encrypted device-to-device transfers'}</div></section><div class="help-card">${icon('info')}<div><h3>Works better together</h3><p>Use Super Send on both devices and keep them on the same local network.</p></div></div></aside></div>`;

  }



  function renderModal() {

    const request = state.requests[0];

    if (request) {

      const files = request.files || [];

      patchMarkup($('modal-root'), `<div class="modal-backdrop" data-modal="request:${esc(request.id)}"><section class="modal" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="incoming-title"><div class="incoming-icon">${icon('receive')}</div><span class="eyebrow">INCOMING TRANSFER</span><h2 id="incoming-title" style="font-size:25px;margin-top:9px;letter-spacing:-.6px">${esc(request.alias)} wants to share</h2><p class="incoming-subtitle">${fileCount(files.length)} · ${bytes(sumSize(files))}<br>From ${esc(request.host || 'your local network')}</p><div class="incoming-files">${files.map((file) => `<div class="file-row"><div class="file-icon">${icon(fileIcon(file))}</div><div class="file-details"><div class="file-name" title="${esc(file.fileName)}">${esc(file.fileName)}</div><div class="file-meta">${bytes(file.size)}${file.preview ? ' · Text message' : ''}</div></div></div>`).join('')}</div><div class="incoming-note">${icon('folder')}Files will be saved to ${esc(state.settings.downloadDir)}.</div><div class="modal-actions"><button class="button outline" data-action="respond" data-id="${esc(request.id)}" data-accept="false" ${disabled(`respond:${request.id}`)}>Decline</button><button autofocus class="button primary" data-action="respond" data-id="${esc(request.id)}" data-accept="true" ${disabled(`respond:${request.id}`)}>${icon('check')}Accept</button></div></section></div>`);

      return;

    }

    const modal = ui.modal;

    if (!modal) { patchMarkup($('modal-root'), ''); return; }

    let content = '';

    const head = (title, description) => `<div class="modal-head"><div><h2 id="modal-title">${title}</h2>${description ? `<p>${description}</p>` : ''}</div><button type="button" class="icon-button" data-action="close-modal" aria-label="Close">${icon('close')}</button></div>`;

    if (modal.type === 'manual') {

      content = `<form id="manual-form">${head('Connect to a device', 'Enter the local IP address shown on the other device’s Receive screen.')}<div class="field"><label for="manual-host">IP address</label><input id="manual-host" autofocus placeholder="192.168.1.100" value="${esc(modal.host || '')}" required autocomplete="off" spellcheck="false"></div><div class="advanced-grid"><div class="field"><label for="manual-port">Port</label><input id="manual-port" type="number" min="1" max="65535" required value="${esc(modal.port)}"></div><div class="field"><label for="manual-protocol">Protocol</label><select id="manual-protocol"><option value="https"${modal.protocol !== 'http' ? ' selected' : ''}>HTTPS</option><option value="http"${modal.protocol === 'http' ? ' selected' : ''}>HTTP</option></select></div></div><div class="modal-actions"><button type="button" class="button outline" data-action="close-modal">Cancel</button><button class="button primary" type="submit" ${disabled('manual-connect')}>${icon('link')}${ui.busy.has('manual-connect') ? 'Connecting…' : 'Connect'}</button></div></form>`;

    } else if (modal.type === 'text') {

      content = `<form id="text-form">${head('Send a message', 'Send a message, a link, or anything you can type.')}<div class="field"><label class="visually-hidden" for="message-text">Text to send</label><textarea id="message-text" autofocus placeholder="What would you like to share?" required>${esc(modal.text || '')}</textarea><span class="field-hint">${(modal.text || '').length.toLocaleString()} characters</span></div><div class="modal-actions"><button type="button" class="button outline" data-action="close-modal">Cancel</button><button class="button primary" type="submit" ${disabled('add-text')}>${icon('add')}Add to selection</button></div></form>`;

    } else if (modal.type === 'rename') {

      content = `<form id="rename-form">${head('Make it your own', 'Give this device a name you’ll recognize.')}<div class="field"><label for="rename-alias">Device name</label><input id="rename-alias" autofocus maxlength="80" required value="${esc(modal.alias)}" autocomplete="off" spellcheck="false"></div><div class="modal-actions"><button type="button" class="button outline" data-action="close-modal">Cancel</button><button class="button primary" type="submit" ${disabled('rename')}>Save name</button></div></form>`;

    } else if (modal.type === 'preview') {

      content = `${head(esc(modal.name || 'Text message'), '')}<div class="text-preview">${esc(modal.text)}</div><div class="modal-actions"><button class="button outline" data-action="close-modal">Close</button><button class="button primary" data-action="copy-preview">${icon('copy')}Copy text</button></div>`;

    }

    patchMarkup($('modal-root'), `<div class="modal-backdrop" data-modal="${esc(modal.type)}"><section class="modal${modal.type === 'text' || modal.type === 'preview' ? ' large' : ''}" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="modal-title">${content}</section></div>`);

  }



  function navigate(page) {

    ui.page = page;

    render();

    $('page-scroll').scrollTop = 0;

  }

  function openModal(type, data = {}) {

    ui.modal = { type, ...data };

    render();

  }

  function closeModal(){ui.modal=null;render();}

  function getTransferFile(button) {

    return transfers().find((transfer) => transfer.id === button.dataset.transfer)?.files?.find((file) => file.id === button.dataset.id);

  }

  async function chooseFiles(folder = false) {

    ui.page = 'send';

    await command(folder ? 'select-folder' : 'select-files', () => folder ? api.selectFolder() : api.selectFiles());

  }

  async function pasteText() {

    ui.page = 'send';

    await command('paste', async () => {

      const contents = await api.readClipboard();

      const text = typeof contents === 'string' ? contents : contents?.text;

      if (!text) { toast('Your clipboard has no text to share.'); return state; }

      return api.addText(text);

    });

  }

  async function discover() {

    ui.scanning = true;

    const start = Date.now();

    await command('discover', () => api.discover());

    window.setTimeout(() => { ui.scanning = false; render(); }, Math.max(0, 800 - (Date.now() - start)));

  }

  async function chooseDownloadDirectory() {

    const result = await command('choose-downloads', () => api.chooseDownloadDirectory());

    if (result) ui.downloadDraft = null;

    render();

  }

  document.addEventListener('click', async (event) => {

    if (event.target.classList.contains('modal-backdrop') && !state?.requests.length) { closeModal();return; }

    const button = event.target.closest('[data-action]');

    if (!button || button.disabled || !state) return;

    const { action, id } = button.dataset;

    switch (action) {

      case 'navigate': navigate(button.dataset.page); break;

      case 'dismiss-toast': $(`toast-${id}`)?.remove(); break;

      case 'select-files': await chooseFiles(); break;

      case 'select-folder': await chooseFiles(true); break;

      case 'text': openModal('text', { text: '' }); break;

      case 'paste': await pasteText(); break;

      case 'connect-phone':

      case 'manual': openModal('manual', { host: '', port: 53317, protocol: 'https' }); break;

      case 'rename': openModal('rename', { alias: state.device.alias }); break;

      case 'close-modal': closeModal();break;

      case 'remove-selection': await command(`remove:${id}`, () => api.removeSelection(id)); break;

      case 'clear-selection': await command('clear-selection', () => api.clearSelection()); break;

      case 'discover': await discover(); break;

      case 'send':

        if (!state.selection.length) { toast('Choose a file, a folder, or some text first.'); break; }

        await command(`send:${id}`, () => api.send(id));

        break;

      case 'cancel-transfer': await command(`cancel:${id}`, () => api.cancelTransfer(id)); break;

      case 'respond': await command(`respond:${id}`, () => api.respond({ requestId: id, accept: button.dataset.accept === 'true' })); break;

      case 'open-downloads': await command('open-downloads', () => api.openDownloads(), undefined, false); break;

      case 'choose-downloads': await chooseDownloadDirectory(); break;

      case 'toggle-accept': await command('auto-accept', () => api.updateSettings({ autoAccept: !state.settings.autoAccept })); break;

      case 'toggle-advanced': await command('advanced', () => api.updateSettings({ showAdvanced: !state.settings.showAdvanced })); break;

      case 'theme': await command('theme', () => api.updateSettings({ theme: id })); break;

      case 'save-alias': {

        const alias = $('settings-alias').value.trim();

        if (!alias) { toast('Please give your device a name.', true); break; }

        const result = await command('save-alias', () => api.updateSettings({ alias }), 'Device name saved.');

        if (result) ui.aliasDraft = null;

        render();

        break;

      }

      case 'save-downloads': {

        const downloadDir = $('settings-downloads').value.trim();

        if (!downloadDir) { toast('Choose a folder for received files.', true); break; }

        const result = await command('save-downloads', () => api.updateSettings({ downloadDir }), 'Download folder saved.');

        if (result) ui.downloadDraft = null;

        render();

        break;

      }

      case 'copy-address': await command('copy-address', () => api.copyText(state.device.addresses?.[0] || ''), 'IP address copied.', false); break;

      case 'copy-fingerprint': if (state.device.fingerprint) await command('copy-fingerprint', () => api.copyText(state.device.fingerprint), 'Fingerprint copied.', false); break;

      case 'filter': ui.filter = id; render(); break;

      case 'expand-transfer': ui.expanded.has(id) ? ui.expanded.delete(id) : ui.expanded.add(id); render(); break;

      case 'view-transfer':

        ui.filter = 'all'; ui.search = ''; ui.expanded.add(id); navigate('history');

        document.getElementById(`transfer-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

        break;

      case 'preview-selection': {

        const file = state.selection.find((item) => item.id === id);

        if (file) openModal('preview', { name: file.name, text: file.text });

        break;

      }

      case 'preview-text': {

        const file = getTransferFile(button);

        if (file) openModal('preview', { name: file.name || file.fileName, text: file.text });

        break;

      }

      case 'copy-file-text': {

        const file = getTransferFile(button);

        if (file?.text !== undefined) await command('copy-text', () => api.copyText(file.text), 'Text copied.', false);

        break;

      }

      case 'copy-preview': await command('copy-text', () => api.copyText(ui.modal?.text || ''), 'Text copied.', false); break;

      case 'open-file': {

        const file = getTransferFile(button);

        if (file?.path) await command('open-file', () => api.openFile(file.path), undefined, false);

        break;

      }

    }

  });

  document.addEventListener('input', (event) => {

    const { id, value } = event.target;

    if (id === 'history-search') { ui.search = value; render(); }

    else if (id === 'settings-alias') ui.aliasDraft = value;

    else if (id === 'settings-downloads') ui.downloadDraft = value;

    else if (ui.modal) {

      if (id === 'message-text') { ui.modal.text = value; const hint = event.target.parentElement.querySelector('.field-hint'); if (hint) hint.textContent = `${value.length.toLocaleString()} characters`; }

      else if (id === 'manual-host') ui.modal.host = value;

      else if (id === 'manual-port') ui.modal.port = value;

      else if (id === 'rename-alias') ui.modal.alias = value;

    }

  });

  document.addEventListener('change', (event) => {

    if (event.target.id === 'manual-protocol' && ui.modal) ui.modal.protocol = event.target.value;

  });

  document.addEventListener('submit', async (event) => {

    event.preventDefault();

    if (!ui.modal || !state) return;

    const { type } = ui.modal;

    if (type === 'manual') {

      const host = $('manual-host').value.trim();

      const port = Number($('manual-port').value);

      const protocol = $('manual-protocol').value;

      if (!host || !Number.isInteger(port) || port < 1 || port > 65535) { toast('Enter a valid IP address and port.', true); return; }

      const result = await command('manual-connect', () => api.addPeer({ host, port, protocol }));

      if (result) { ui.modal = null; navigate('send'); toast('Device connected. Choose it to send your selection.'); }

    } else if (type === 'text') {

      const text = $('message-text').value;

      if (!text.trim()) { toast('Write something to share first.'); return; }

      const result = await command('add-text', () => api.addText(text));

      if (result) { ui.modal = null; navigate('send'); }

    } else if (type === 'rename') {

      const alias = $('rename-alias').value.trim();

      if (!alias) { toast('Please give your device a name.', true); return; }

      const result = await command('rename', () => api.updateSettings({ alias }), 'Device name saved.');

      if (result) { ui.modal = null; ui.aliasDraft = null; render(); }

    }

  });



  document.addEventListener('keydown', (event) => {

    const modal = $('modal-root').querySelector('[role="dialog"]');

    if (modal) {

      if (event.key === 'Escape') {

        event.preventDefault();

        if (state?.requests.length) void command(`respond:${state.requests[0].id}`, () => api.respond({ requestId: state.requests[0].id, accept: false }));

        else closeModal();

      }

      if (event.key === 'Tab') {

        const elements = [...modal.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]')];

        const first = elements[0]; const last = elements[elements.length - 1];

        if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }

        else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }

      }

      return;

    }

    const editing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.target.isContentEditable;

    if (!editing && state && (event.ctrlKey || event.metaKey)) {

      if (event.key.toLowerCase() === 'o') { event.preventDefault(); void chooseFiles(event.shiftKey); }

      else if (event.key.toLowerCase() === 'v' && ui.page === 'send') { event.preventDefault(); void pasteText(); }

    }

  });

  function isFileDrag(event) { return Array.from(event.dataTransfer?.types || []).includes('Files'); }

  document.addEventListener('dragenter', (event) => {

    if (!isFileDrag(event) || !state) return;

    event.preventDefault(); dragDepth++; $('drop-overlay').hidden = false;

  });

  document.addEventListener('dragover', (event) => {

    if (!isFileDrag(event)) return;

    event.preventDefault(); event.dataTransfer.dropEffect = 'copy';

  });

  document.addEventListener('dragleave', (event) => {

    if (!isFileDrag(event)) return;

    event.preventDefault(); dragDepth = Math.max(0, dragDepth - 1);

    if (!dragDepth) $('drop-overlay').hidden = true;

  });

  document.addEventListener('drop', async (event) => {

    event.preventDefault(); dragDepth = 0; $('drop-overlay').hidden = true;

    if (!state) return;

    const files = Array.from(event.dataTransfer?.files || []);

    if (!files.length) return;

    ui.page = 'send';

    await command('drop', async () => {

      const paths = await api.getDroppedPaths(files);

      if (!paths?.length) throw new Error('These files could not be added. Use the Files button to choose them.');

      return api.addPaths(paths);

    });

  });

  window.addEventListener('blur', () => { dragDepth = 0; $('drop-overlay').hidden = true; });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);



  async function start() {

    if (!api || typeof api.getState !== 'function') {

      $('page').innerHTML = `<div class="startup-state"><div class="soft-icon">${icon('warning')}</div><h1>The desktop connection is missing</h1><p>Open Super Send using its desktop launcher. The desktop connection is required to discover devices and share files.</p><div class="startup-error">window.localSend is unavailable.</div></div>`;

      $('network-status').classList.add('offline');

      $('network-status').innerHTML = '<span class="status-dot"></span>Desktop connection unavailable';

      return;

    }

    try {

      api.onState(applyState);

      applyState(await api.getState());

      // Decay stalled transfers to zero even when the engine has no new state.
      const rateTimer = window.setInterval(() => {
        for (const element of document.querySelectorAll('[data-transfer-rate]')) {
          const measured = transferRates.read(element.dataset.transferRate);
          const label = formatTransferSpeed(measured?.bytesPerSecond);
          if (element.textContent !== label) element.textContent = label;
        }
      }, 500);
      window.addEventListener('beforeunload', () => window.clearInterval(rateTimer), { once: true });

    } catch (error) {

      $('page').innerHTML = `<div class="startup-state"><div class="soft-icon">${icon('warning')}</div><h1>Super Send couldn’t get ready</h1><p>Close this window and reopen the desktop app.</p><div class="startup-error">${esc(error.message || error)}</div></div>`;

    }

  }

  void start();

})();

