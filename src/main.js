const ui = {
  root: null,
  upstream: null,
  files: [],
  selected: null,
  async invoke(action) {
    try { return await action(); }
    catch (error) { this.message(error?.message || 'Échec de l’opération Git. Les données sensibles ne sont pas affichées.'); return null; }
  },
  message(text) { document.querySelector('#status-message').textContent = text; },
  async open(data) {
    if (!data) return;
    document.querySelector('#repo-path').textContent = data.root;
    document.querySelector('#empty-state').hidden = true;
    document.querySelectorAll('.rightbar .action-button').forEach((button) => { button.disabled = false; });
    this.update(data.status, data.history);
    this.message('Dépôt ouvert en lecture locale. Aucun contenu n’a été transmis.');
  },
  update(status, history = []) {
    this.files = status.files;
    this.upstream = status.upstream;
    document.querySelector('#branch-name').textContent = status.branch;
    document.querySelector('#upstream-label').textContent = status.upstream || 'Upstream non configuré';
    document.querySelector('#push-button').disabled = !status.upstream;
    document.querySelector('#change-count').textContent = String(status.files.length);
    document.querySelector('#file-list').replaceChildren();
    for (const file of status.files) {
      const row = document.createElement('div');
      row.className = `file-item${this.selected === file.path ? ' selected' : ''}`;
      const mark = document.createElement('span'); mark.className = 'file-status'; mark.textContent = file.untracked ? '?' : file.staged ? '●' : '○';
      const name = document.createElement('span'); name.className = 'path'; name.textContent = file.path; name.title = file.path;
      const toggle = document.createElement('button'); toggle.className = 'stage'; toggle.textContent = file.staged ? '−' : '+'; toggle.title = file.staged ? 'Retirer de l’index' : 'Ajouter à l’index';
      toggle.addEventListener('click', async (event) => {
        event.stopPropagation();
        const result = await this.invoke(() => file.staged ? window.workbench.unstage(file.path) : window.workbench.stage(file.path));
        if (result) { this.update(result); if (this.selected === file.path) await this.showDiff(file.path); }
      });
      row.append(mark, name, toggle);
      row.addEventListener('click', () => this.showDiff(file.path));
      document.querySelector('#file-list').append(row);
    }
    document.querySelector('#commit-button').disabled = !status.files.some((file) => file.staged);
    this.renderHistory(history);
  },
  async showDiff(filePath) {
    this.selected = filePath;
    document.querySelector('#view-title').textContent = filePath;
    document.querySelector('#history-panel').hidden = true;
    document.querySelector('#empty-state').hidden = true;
    const staged = this.files.find((file) => file.path === filePath)?.staged === true;
    const result = await this.invoke(() => window.workbench.diff(filePath, staged));
    if (result === null) return;
    const pane = document.querySelector('#diff-view'); pane.hidden = false; pane.replaceChildren();
    if (!result) { pane.textContent = 'Aucun diff disponible pour cette sélection.'; return; }
    for (const line of result.split('\n')) {
      const row = document.createElement('div');
      row.textContent = line;
      if (line.startsWith('+') && !line.startsWith('+++')) row.className = 'diff-add';
      if (line.startsWith('-') && !line.startsWith('---')) row.className = 'diff-del';
      pane.append(row);
    }
  },
  renderHistory(history) {
    const list = document.querySelector('#history-list'); list.replaceChildren();
    for (const commit of history) {
      const row = document.createElement('div'); row.className = 'history-row';
      const id = document.createElement('code'); id.textContent = commit.shortHash;
      const subject = document.createElement('p'); subject.textContent = commit.subject;
      const meta = document.createElement('small'); meta.textContent = `${commit.author} · ${commit.date}`;
      row.append(id, subject, meta); list.append(row);
    }
  },
};

document.querySelector('#open-repo').addEventListener('click', async () => ui.open(await ui.invoke(() => window.workbench.chooseRepository())));
document.querySelector('#empty-open').addEventListener('click', async () => ui.open(await ui.invoke(() => window.workbench.chooseRepository())));
document.querySelector('#refresh').addEventListener('click', async () => {
  const result = await ui.invoke(() => window.workbench.refresh()); if (result) ui.update(result.status, result.history);
});
document.querySelector('#history-tab').addEventListener('click', async () => {
  const result = await ui.invoke(() => window.workbench.refresh()); if (!result) return;
  ui.update(result.status, result.history); document.querySelector('#diff-view').hidden = true;
  document.querySelector('#history-panel').hidden = false; document.querySelector('#view-title').textContent = 'Historique récent';
});
document.querySelector('#commit-message').addEventListener('input', (event) => {
  document.querySelector('#commit-button').disabled = !ui.files.some((file) => file.staged) || !event.target.value.trim();
});
document.querySelector('#commit-button').addEventListener('click', async () => {
  const message = document.querySelector('#commit-message').value;
  if (!message.trim()) { ui.message('Un message de commit non vide est requis.'); return; }
  const hash = await ui.invoke(() => window.workbench.commit(message));
  if (hash) { document.querySelector('#commit-message').value = ''; const result = await window.workbench.refresh(); ui.update(result.status, result.history); ui.message(`Commit local créé : ${hash.slice(0, 12)}.`); }
});
document.querySelector('#push-button').addEventListener('click', async () => {
  const result = await ui.invoke(() => window.workbench.push(ui.upstream));
  if (result) ui.message(`Push vérifié vers ${result.upstream} (${result.hash.slice(0, 12)}).`);
});
document.querySelector('#new-branch').addEventListener('click', async () => {
  const name = window.prompt('Nom de la nouvelle branche locale :'); if (!name) return;
  const result = await ui.invoke(() => window.workbench.createBranch(name)); if (result) ui.update(result);
});
document.querySelector('#branches-button').addEventListener('click', async () => {
  const result = await ui.invoke(() => window.workbench.refresh()); if (!result) return;
  const branches = await ui.invoke(() => window.workbench.branches()); if (!branches) return;
  const choices = branches.map(({ name, current }) => `${current ? '→ ' : '  '}${name}`).join('\n');
  const target = window.prompt(`Branche actuelle : ${result.status.branch}\nBranches locales :\n${choices}\n\nSaisir le nom d’une branche existante à changer :`);
  if (!target) return;
  const switched = await ui.invoke(() => window.workbench.switchBranch(target)); if (switched) ui.update(switched);
});
document.querySelector('#cherry-button').addEventListener('click', async () => {
  const commit = window.prompt('Hash du commit à appliquer (7 à 40 caractères hexadécimaux) :'); if (!commit) return;
  const result = await ui.invoke(() => window.workbench.cherryPick(commit)); if (result) { ui.update(result.status); ui.message(`Cherry-pick terminé. Récupération conservée : ${result.recoveryRef}.`); }
});
document.querySelector('#rebase-button').addEventListener('click', async () => {
  const upstream = window.prompt('Nom de branche locale/distante ou hash du commit de base :'); if (!upstream) return;
  const result = await ui.invoke(() => window.workbench.rebase(upstream)); if (result) { ui.update(result.status); ui.message(`Rebase terminé. Récupération conservée : ${result.recoveryRef}.`); }
});
document.querySelector('#rebase-interactive-button').addEventListener('click', async () => {
  const upstream = window.prompt('Branche ou hash de base du rebase interactif :'); if (!upstream) return;
  const data = await ui.invoke(() => window.workbench.interactiveRebaseCommits(upstream));
  if (!data || !data.commits.length) { ui.message('Aucun commit à réorganiser pour cette base.'); return; }
  const commitList = data.commits.map(({ shortHash, subject }) => `${shortHash} ${subject}`).join('\n');
  const starter = data.commits.map(({ shortHash }) => `pick ${shortHash}`).join(', ');
  const input = window.prompt(`Plan exact, de l’ancien au nouveau. Actions : pick, drop, fixup.\n${commitList}\n\nModifier la liste « action hash » séparée par des virgules :`, starter);
  if (!input) return;
  const byShort = new Map(data.commits.map((commit) => [commit.shortHash, commit.hash]));
  const plan = input.split(',').map((item) => {
    const [action, hash] = item.trim().split(/\s+/, 2);
    const fullHash = byShort.get(hash);
    return { action, hash: fullHash || hash };
  });
  const result = await ui.invoke(() => window.workbench.interactiveRebase(upstream, plan));
  if (result) { ui.update(result.status); ui.message(`Rebase interactif terminé. Récupération conservée : ${result.recoveryRef}.`); }
});
