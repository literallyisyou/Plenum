// Discover and open saved chats by title or message. Markdown export follows the chat on screen.
(function () {
  const MU = window.MuseUI;
  if (!MU) return;

  const TITLE = 'Search chats';
  const DELAY = 250;
  const MAX_QUERY = 200;
  const SURFACE = document.documentElement.dataset.surface;
  const activeProject = () => MU.state.activeProject;
  const activeThread = () => MU.threads.scope();
  const patternFor = q => new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
  let disposePanel;

  function entryPoint(className, scope) {
    const b = MU.button(className, '');
    b.append(MU.icon('search'));
    if (scope === 'all') b.append(MU.span('ext-history-link-label', TITLE));
    b.title = scope === 'all' ? 'Search chats across projects (Ctrl+Shift+F)' : 'Search chats in this project (Ctrl+Shift+F)';
    b.setAttribute('aria-label', TITLE);
    b.setAttribute('aria-haspopup', 'dialog');
    b.addEventListener('click', () => openSearch(scope, b));
    return b;
  }

  function openSearch(scope, from) {
    if (MU.dialogOpen?.()) return;
    const initialScope = activeProject() ? scope : 'all';
    MU.openDrawer(TITLE, body => renderPanel(body, initialScope, from));
  }

  // Preserve the renderer's placeholder turns so older hits can be scrolled into view.
  function turnKind(m) {
    if (m.draft === true) return null;
    if (m.compact) return 'summary';
    if (m.role === 'user') return m.kind === 'build' ? null : 'user';
    if (m.kind === 'advisor') return 'advisor';
    if (m.kind === 'council' || m.kind === 'build') return null;
    if ((m.content ?? '').trim()) return 'assistant';
    return (m.tools ?? []).length || m.computerRun || m.error || m.aborted || m.interrupted ? null : 'assistant';
  }

  function matchingTurn(hit, pattern) {
    const messages = MU.state.messages ?? [];
    const msg = messages[hit.index];
    if (!msg || msg.role !== hit.role || (hit.ts && msg.ts !== hit.ts)) return null;
    const text = msg.role === 'assistant' ? globalThis.PlenumAssistantContent?.clean(msg.content).text ?? msg.content : msg.content;
    if (!pattern.test(text ?? '')) return null;
    const kind = turnKind(msg);
    if (!kind) return null;
    const sameKind = messages.filter(m => turnKind(m) === kind);
    const turns = MU.stream().querySelectorAll(`.turn.${kind}`);
    if (turns.length !== sameKind.length) return null;
    return turns[sameKind.indexOf(msg)] ?? null;
  }

  function highlight(text, pattern) {
    const node = MU.span('ext-history-snippet', '');
    const match = pattern.exec(text);
    if (!match) {
      node.textContent = text;
      return node;
    }
    const mark = document.createElement('mark');
    mark.textContent = match[0];
    node.append(text.slice(0, match.index), mark, text.slice(match.index + match[0].length));
    return node;
  }

  async function activateHit(hit) {
    const { project, thread } = hit;
    if (thread.closed) {
      const state = await MU.api('/api/threads/reopen', { project: project.id, thread: thread.id });
      MU.threads.adopt(state);
    }
    if (activeProject() !== project.id) await MU.update({ activeProject: project.id });
    if (activeThread() !== thread.id) await MU.threads.switchTo(thread.id);
    if (activeProject() !== project.id || activeThread() !== thread.id) throw new Error('Plenum could not open that chat.');
  }

  function jumpToChat(hit, pattern) {
    // The phone's Projects screen hides the transcript until Chat is selected.
    if (SURFACE === 'phone' && document.documentElement.dataset.phTab !== 'chat') {
      document.querySelector('#ph-bar [data-tab="chat"]')?.click();
    }
    requestAnimationFrame(() => {
      if (activeProject() !== hit.project.id || activeThread() !== hit.thread.id) return;
      const turn = hit.kind === 'message' ? matchingTurn(hit, pattern) : null;
      const focus = turn ?? MU.el.chat;
      turn?.scrollIntoView({ block: 'center' });
      if (turn) {
        turn.classList.add('ext-history-hit');
        setTimeout(() => turn.classList.remove('ext-history-hit'), 1600);
      }
      if (!focus.hasAttribute('tabindex')) {
        focus.tabIndex = -1;
        focus.addEventListener('blur', () => focus.removeAttribute('tabindex'), { once: true });
      }
      focus.focus({ preventScroll: true });
    });
  }

  function renderPanel(body, initialScope, from) {
    disposePanel?.();
    const panel = document.createElement('section');
    panel.className = 'ext-history-panel';
    const form = document.createElement('form');
    form.className = 'ext-history-bar';
    form.setAttribute('role', 'search');

    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'ext-history-input';
    input.maxLength = MAX_QUERY;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'Search chat titles and messages';
    input.setAttribute('aria-label', input.placeholder);

    const scopes = document.createElement('fieldset');
    scopes.className = 'ext-history-scopes';
    const legend = document.createElement('legend');
    legend.textContent = 'Search scope';
    scopes.append(legend);
    const local = addScope('project', 'This project');
    const all = addScope('all', 'All projects');
    all.checked = initialScope === 'all';
    local.checked = !all.checked;

    function addScope(value, title) {
      const option = document.createElement('input');
      option.type = 'radio';
      option.name = 'chat-search-scope';
      option.value = value;
      const label = document.createElement('label');
      label.append(option, MU.span('', title));
      scopes.append(label);
      return option;
    }

    const exportBtn = MU.button('ghost small ext-history-export', 'Export current chat');
    exportBtn.title = 'Download the current chat as a Markdown file';
    const tools = document.createElement('div');
    tools.className = 'ext-history-tools';
    tools.append(scopes, exportBtn);
    form.append(input, tools);

    const status = MU.para('');
    status.className = 'ext-history-note';
    status.setAttribute('role', 'status');
    const error = MU.para('');
    error.className = 'ext-history-error';
    error.setAttribute('role', 'alert');
    const list = document.createElement('ul');
    list.className = 'ext-history-list';
    list.setAttribute('aria-label', 'Matching chats and messages');
    panel.append(form, status, error, list);
    body.append(panel);

    let timer;
    let pending;
    let opening = false;
    let current = activeProject();
    let closed = false;
    const drawer = MU.el.drawer;

    function cancelSearch() {
      clearTimeout(timer);
      pending?.abort();
      pending = null;
      list.removeAttribute('aria-busy');
    }

    function closePanel() {
      cancelSearch();
      closed = true;
      observer.disconnect();
      unsubscribe?.();
      if (disposePanel === closePanel) disposePanel = undefined;
    }

    const observer = new MutationObserver(() => {
      if (!drawer.hidden && panel.isConnected) return;
      closePanel();
      if (drawer.hidden && (panel.contains(document.activeElement) || document.activeElement === document.body)) from?.focus({ preventScroll: true });
    });
    observer.observe(drawer, { attributes: true, attributeFilter: ['hidden'] });
    observer.observe(body, { childList: true });
    const unsubscribe = MU.threads.onRender?.(() => {
      if (current === activeProject()) return;
      current = activeProject();
      syncAvailability();
      if (local.checked && !opening) scheduleSearch(true);
    });
    disposePanel = closePanel;

    function syncAvailability() {
      local.disabled = !current;
      if (local.disabled) all.checked = true;
      exportBtn.disabled = !current || opening;
    }

    function scheduleSearch(immediate = false) {
      if (opening || closed) return;
      cancelSearch();
      error.textContent = '';
      list.replaceChildren();
      const q = input.value.trim();
      if (!q) {
        status.textContent = 'Enter a title, word, or phrase.';
        return;
      }
      status.textContent = 'Searching…';
      list.setAttribute('aria-busy', 'true');
      if (immediate) search(q, all.checked, current);
      else timer = setTimeout(() => search(q, all.checked, current), DELAY);
    }

    async function search(q, everywhere, project) {
      const controller = new AbortController();
      pending = controller;
      const params = new URLSearchParams({ q });
      if (!everywhere) params.set('project', project ?? '');
      const route = everywhere ? '/api/history/search-all' : '/api/history/search';
      try {
        const data = await MU.api(`${route}?${params}`, undefined, { signal: controller.signal });
        if (pending !== controller || closed) return;
        const hits = Array.isArray(data?.results) ? data.results : [];
        const pattern = patternFor(q);
        const rows = hits.map(hit => resultRow(hit, pattern));
        list.replaceChildren(...rows);
        if (!rows.length) status.textContent = everywhere ? 'No matches in any project.' : 'No matches in this project.';
        else if (data.more) status.textContent = `Showing ${rows.length} matches. Refine your search to see more specific results.`;
        else status.textContent = `${rows.length} ${rows.length === 1 ? 'match' : 'matches'}.`;
      } catch (err) {
        if (pending !== controller || closed) return;
        status.textContent = '';
        error.textContent = MU.plainError(err, 'Plenum could not search chats. Press Enter to try again.');
      } finally {
        if (pending === controller) {
          pending = null;
          list.removeAttribute('aria-busy');
        }
      }
    }

    function resultRow(hit, pattern) {
      const item = document.createElement('li');
      const row = MU.button('ext-history-result', '');
      const titleHit = hit.kind === 'title';
      const name = hit.thread.main ? `${hit.project.name} · Main` : hit.thread.name;
      const label = MU.span('ext-history-title', '');
      label.append(titleHit ? highlight(name, pattern) : name);
      if (hit.thread.closed) label.append(MU.span('ext-history-closed', 'Closed'));
      const context = [hit.thread.main ? '' : hit.project.name, titleHit ? 'Chat title' : hit.role === 'user' ? 'You' : 'Assistant'];
      row.append(label, MU.span('ext-history-context', context.filter(Boolean).join(' · ')));
      if (!titleHit) row.append(highlight(hit.snippet, pattern));
      if (hit.thread.closed) row.append(MU.span('ext-history-action', 'Reopen chat'));
      row.addEventListener('click', () => openHit(hit, pattern, row));
      item.append(row);
      return item;
    }

    async function openHit(hit, pattern, row) {
      if (opening) return;
      opening = true;
      input.disabled = scopes.disabled = true;
      syncAvailability();
      row.setAttribute('aria-busy', 'true');
      error.textContent = '';
      status.textContent = hit.thread.closed ? 'Reopening chat…' : 'Opening chat…';
      try {
        await activateHit(hit);
        if (closed) return;
        closePanel();
        MU.closeDrawer();
        jumpToChat(hit, pattern);
      } catch (err) {
        if (closed) return;
        status.textContent = '';
        error.textContent = MU.plainError(err, 'Plenum could not open that chat.');
      } finally {
        opening = false;
        input.disabled = scopes.disabled = false;
        syncAvailability();
        row.removeAttribute('aria-busy');
      }
    }

    exportBtn.addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = `/api/history/export?${new URLSearchParams({ project: activeProject(), thread: activeThread() })}`;
      a.download = '';
      document.body.append(a);
      a.click();
      a.remove();
    });

    form.addEventListener('submit', e => {
      e.preventDefault();
      scheduleSearch(true);
    });
    input.addEventListener('input', () => scheduleSearch());
    input.addEventListener('keydown', e => {
      if (e.key !== 'ArrowDown' || !list.firstElementChild) return;
      e.preventDefault();
      list.querySelector('button')?.focus();
    });
    scopes.addEventListener('change', () => scheduleSearch(true));
    syncAvailability();
    scheduleSearch();
    input.focus();
  }

  const sidebar = document.getElementById('projects');
  if (sidebar && !document.getElementById('historyBtn')) {
    const side = entryPoint('side-link ext-history-side', 'all');
    side.id = 'historyBtn';
    sidebar.before(side);
  }
  const titlebar = document.getElementById('titlebar');
  if (titlebar) {
    const chat = entryPoint('icon-btn ext-history-top', 'project');
    titlebar.insertBefore(chat, titlebar.querySelector('.titlebar-space'));
    document.addEventListener('keydown', event => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey || !event.shiftKey || !(event.ctrlKey || event.metaKey) || event.code !== 'KeyF') return;
      if (MU.dialogOpen?.() || !MU.el.drawer.hidden) return;
      event.preventDefault();
      openSearch('project', chat);
    });
  }
})();
