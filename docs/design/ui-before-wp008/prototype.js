/* global document */
// 独立设计原型；所有设备、目录、任务和备份都来自内存中的示例数据。
const state = {
  page: 'games',
  platform: 'mobile',
  theme: 'light',
  scenario: 'normal',
  gameId: 'stellar',
  upload: false,
  removeExtra: false,
  backup: true,
  computerPath: [],
  phonePath: [],
  sheet: false,
  serviceRunning: true,
  editingDeviceId: null,
  backupChoice: '',
  restoreStatus: 'idle',
  task: null,
  devices: [
    {
      id: 'pc-home',
      type: 'desktop',
      name: '书房电脑',
      address: '192.168.1.100:48720',
      connected: true,
    },
    {
      id: 'pc-laptop',
      type: 'desktop',
      name: '游戏笔记本',
      address: '192.168.1.120:48720',
      connected: true,
    },
    {
      id: 'phone-main',
      type: 'mobile',
      name: '我的手机',
      address: '192.168.1.105',
      connected: true,
    },
    {
      id: 'phone-spare',
      type: 'mobile',
      name: '备用手机',
      address: '192.168.1.106',
      connected: false,
    },
  ],
  games: [
    {
      id: 'stellar',
      name: '星之旅',
      word: 'STELLAR JOURNEY',
      color: '',
      directories: { mobile: '星之旅 / save', desktop: '星之旅 / savedata' },
      linked: { mobile: ['pc-home', 'pc-laptop'], desktop: ['phone-main', 'phone-spare'] },
      selected: { mobile: 'pc-home', desktop: 'phone-main' },
      remoteDirectories: {
        'pc-home': '星之旅 / savedata',
        'pc-laptop': '星之旅 / saves',
        'phone-main': '星之旅 / save',
        'phone-spare': '星之旅 / savedata',
      },
    },
    {
      id: 'summer',
      name: '夏日来信',
      word: 'SUMMER LETTER',
      color: 'pink',
      directories: { mobile: '夏日来信 / save', desktop: '夏日来信 / savedata' },
      linked: { mobile: ['pc-home'], desktop: ['phone-main'] },
      selected: { mobile: 'pc-home', desktop: 'phone-main' },
      remoteDirectories: { 'pc-home': '夏日来信 / savedata', 'phone-main': '夏日来信 / save' },
    },
  ],
}
const $ = (id) => document.getElementById(id)
const NAV = [
  ['connection', 'devices', '设备'],
  ['games', 'game', '游戏'],
  ['settings', 'settings', '设置'],
]
const ICONS = {
  devices: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 21h8m-4-5v5"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 18h4"/>',
  game: '<path d="M8 7h8c4 0 6 10 3 11-2 1-4-3-5-3h-4c-1 0-3 4-5 3C2 17 4 7 8 7Z"/><path d="M7 10v4m-2-2h4m6-1h.01m2 2h.01"/>',
  settings:
    '<path d="m9 3-1 3-3 1-2 4 2 2 1 4 4 2 2-1 4 1 3-3-1-3 2-3-2-4-3-1-2-3Z"/><circle cx="11" cy="11" r="3"/>',
  folder: '<path d="M3 6h7l2 3h9v11H3Z"/>',
  transfer: '<path d="M3 7h17l-4-4m4 4-4 4M21 17H4l4-4m-4 4 4 4"/>',
}
const NOTES = {
  games: [
    '一个游戏，关联多台设备',
    '每个游戏保存本机目录，并关联多台电脑或手机。进入传输页后，从这些设备中明确选择本次对端。',
  ],
  connection: [
    '已保存设备分开管理',
    '每张卡片单独显示连接状态、地址和管理入口。手机可同时连接多台电脑；电脑开启服务后接收多台手机连接。',
  ],
  device: [
    '设备名称与地址独立保存',
    '改址后保留设备关联和游戏目录。移除设备时保留本机游戏存档，相关游戏需要重新选择对端。',
  ],
  transfer: [
    '先选设备，再确认方向',
    '设备选择器只列出这个游戏已关联的设备。切换后更新对端目录，清除旧的浏览位置与预览。两列始终并排显示。',
  ],
  preview: [
    '确认具体设备与变化',
    '预览显示本次对端设备、源和目标目录，以及新增、覆盖和删除项。多台设备可在线，当前一次只执行一项传输。',
  ],
  tasks: [
    '任务固定到发起时的设备',
    '开始后保留游戏、设备、方向和目录。查看别的设备或游戏不会改变进行中的任务，传输状态按接收端结果显示。',
  ],
  edit: [
    '游戏可关联多台设备',
    '本机目录在这里选择，选择后保存。下方列出所有已关联设备及其只读目录，可关联或解除某台设备。',
  ],
  restore: [
    '点击备份直接预览',
    '点击备份后自动展开恢复预览，显示备份时间、目标目录及文件变化，确认后恢复。本页展示本机持有的备份。',
  ],
  settings: ['设置', '主题跟随系统，应用信息和故障排查放在这里。'],
}
function icon(name) {
  return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`
}
function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  )
}
function button(text, action, kind = 'button', extra = '') {
  return `<button class="${kind}" data-action="${action}" ${extra}>${text}</button>`
}
function notice(text) {
  return `<div class="notice" role="status">${text}</div>`
}
function game() {
  return state.games.find((item) => item.id === state.gameId)
}
function savedPeers() {
  return state.devices.filter((item) => item.type !== state.platform)
}
function linkedPeers() {
  return savedPeers().filter((item) => game().linked[state.platform].includes(item.id))
}
function selectedPeer() {
  return linkedPeers().find((item) => item.id === game().selected[state.platform]) ?? null
}
function isConnected(device) {
  return Boolean(
    device?.connected &&
    state.scenario !== 'offline' &&
    (state.platform !== 'desktop' || state.serviceRunning),
  )
}
function isTaskRunning() {
  return state.task?.status === 'running'
}
function isDeviceBusy(id) {
  return isTaskRunning() && state.task.peerId === id && state.task.platform === state.platform
}
function ownLabel() {
  return state.platform === 'desktop' ? '电脑' : '手机'
}
function endpoint(side) {
  const isOwn = (side === 'computer') === (state.platform === 'desktop')
  const peer = selectedPeer()
  return {
    name: isOwn ? `本机${ownLabel()}` : (peer?.name ?? '未选择设备'),
    directory: isOwn
      ? game().directories[state.platform]
      : peer
        ? (game().remoteDirectories[peer.id] ?? '')
        : '',
  }
}
function resetBrowse() {
  state.computerPath = []
  state.phonePath = []
}
function header(title, subtitle = '', back = '') {
  $('header').innerHTML =
    `<div>${back ? button(back === 'connection' ? '‹ 设备' : back === 'transfer' ? '‹ 传输' : '‹ 游戏', back, 'back') : ''}<h1>${title}</h1>${subtitle ? `<p>${subtitle}</p>` : ''}</div>${state.page === 'games' ? button('＋', 'add-game', 'button', 'aria-label="添加游戏"') : state.page === 'connection' ? button('＋', 'add-device', 'button', 'aria-label="添加设备"') : ''}`
}
function empty(title, text, action, label) {
  return `<div class="card empty"><div class="folder">${icon('folder')}</div><h2>${title}</h2><p>${text}</p>${action ? button(label, action, 'primary') : ''}</div>`
}
function peerSelect() {
  const current = selectedPeer()
  return `<label class="peer-selector"><span>对端设备</span><select id="peer-select" aria-label="对端设备"><option value="" ${!current ? 'selected' : ''}>选择设备</option>${linkedPeers()
    .map(
      (item) =>
        `<option value="${item.id}" ${current?.id === item.id ? 'selected' : ''}>${escapeHtml(item.name)} · ${isConnected(item) ? '已连接' : '未连接'}</option>`,
    )
    .join('')}</select></label>`
}
function renderGames() {
  header('游戏')
  if (state.scenario === 'empty')
    return empty('添加第一个游戏', '为游戏选择本机存档目录，并关联设备。', 'add-game', '添加游戏')
  const count = savedPeers().filter(isConnected).length
  return `<div class="connection-strip"><span class="status-dot ${count ? '' : 'off'}"></span><span class="grow">${count} 台设备已连接</span>${button('设备 ›', 'connection', 'link')}</div>${state.task ? `<button class="task-strip" data-action="tasks">${icon('transfer')}<div class="grow"><strong>${escapeHtml(state.task.gameName)} · ${state.task.status === 'running' ? '传输中' : '查看本次结果'}</strong><small>${escapeHtml(state.task.peerName)}</small></div><span>›</span></button>` : ''}<div class="section-title"><h2>我的游戏</h2><span>${state.games.length} 个游戏</span></div><div class="project-grid">${state.games.map((item) => `<button class="game-tile" data-action="game" data-game="${item.id}"><div class="project-cover ${item.color}"><span class="cover-orbit"></span><small>${item.word}</small><b>${escapeHtml(item.name)}</b><span class="cover-caption">SAVE DATA</span></div><div class="file-name">${escapeHtml(item.name)}</div><div class="file-meta">已关联 ${item.linked[state.platform].length} 台设备</div></button>`).join('')}</div>`
}
function deviceCard(item) {
  const connected = isConnected(item)
  return `<article class="saved-device"><button class="device-card-main" data-action="manage-device" data-device="${item.id}"><span class="saved-device-icon">${icon(item.type === 'desktop' ? 'devices' : 'phone')}</span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.address)}</small></button><div class="device-card-state"><span class="status-dot ${connected ? '' : 'off'}"></span><span>${connected ? '已连接' : '未连接'}</span></div><div class="device-card-actions">${connected ? button('断开', 'disconnect-device', 'link', `data-device="${item.id}" ${isDeviceBusy(item.id) ? 'disabled' : ''}`) : state.platform === 'mobile' ? button('连接', 'connect-device', 'link', `data-device="${item.id}"`) : '<span class="waiting-label">等待手机连接</span>'}${button('管理', 'manage-device', 'link', `data-device="${item.id}"`)}</div></article>`
}
function renderConnection() {
  header('设备')
  const service =
    state.platform === 'desktop'
      ? `<div class="card service-card"><div class="row between"><h2>本机服务</h2>${button(state.serviceRunning ? '停止' : '启动', 'service', 'link')}</div>${state.serviceRunning ? '<code>http://192.168.1.100:48720</code>' : '<p>服务已停止</p>'}<details><summary>端口设置</summary><label class="field">0 表示自动分配<input value="0" aria-label="监听端口" ${state.serviceRunning ? 'disabled' : ''}/></label></details></div>`
      : ''
  return `${service}<div class="section-title"><h2>已保存的设备</h2><span>${savedPeers().length} 台</span></div>${savedPeers().length ? `<div class="device-grid">${savedPeers().map(deviceCard).join('')}</div>` : empty('还没有设备', state.platform === 'mobile' ? '添加电脑地址。' : '用手机连接上方地址后保存设备。', 'add-device', '添加设备')}`
}
function renderDevice() {
  const item = state.devices.find((value) => value.id === state.editingDeviceId)
  if (!item && state.platform === 'desktop') {
    header('管理设备', '', 'connection')
    return empty('选择一台设备', '', 'connection', '已保存的设备')
  }
  header(item ? '管理设备' : '添加电脑', '', 'connection')
  $('action').innerHTML =
    `<div class="action-bar">${button(item ? '保存设备' : '添加设备', 'save-device', 'primary')}</div>`
  return `<div class="card"><label class="field">设备名称<input id="device-name" value="${escapeHtml(item?.name ?? '')}" placeholder="例如：书房电脑" /></label>${state.platform === 'mobile' ? `<label class="field">电脑 HTTP 地址<input id="device-address" value="${escapeHtml(item?.address ?? '')}" placeholder="192.168.1.100:48720" /></label>` : `<div class="detail-line"><span>当前地址</span>${escapeHtml(item?.address ?? '未知')}</div>`}</div>${item ? `<div class="device-remove">${button('移除设备', 'forget-device', 'link danger', isDeviceBusy(item.id) ? 'disabled' : '')}</div>` : ''}`
}
function mapping(context) {
  const computer = context?.computer ?? endpoint('computer')
  const phone = context?.phone ?? endpoint('phone')
  return `<div class="mapping"><div><span>${escapeHtml(computer.name)}</span><strong>${escapeHtml(computer.directory || '未设置目录')}</strong></div><div><span>${escapeHtml(phone.name)}</span><strong>${escapeHtml(phone.directory || '未设置目录')}</strong></div></div>`
}
function filePane(side) {
  const computer = side === 'computer'
  const own = computer === (state.platform === 'desktop')
  const details = endpoint(side)
  const path = computer ? state.computerPath : state.phonePath
  const role = state.upload === computer ? '目标' : '源'
  const entries = path.length
    ? [
        ['save01.dat', '128 KiB', '2026-10-27 08:32'],
        ['save02.dat', '64 KiB', '2026-10-26 22:10'],
      ]
    : [
        ['chapter-1', '文件夹 · —', '2026-10-26 22:10'],
        ['save01.dat', '128 KiB', '2026-10-27 08:32'],
        ['save02.dat', '64 KiB', '2026-10-26 22:10'],
        ['system.dat', '大小未知', '2026-10-25 19:42'],
      ]
  let message = ''
  if (!own && !selectedPeer()) message = '请选择设备'
  else if (!own && !isConnected(selectedPeer())) message = '设备未连接'
  else if (!details.directory) message = own ? '未设置目录' : '此设备尚未配置目录'
  else if (state.scenario === 'permission' && own) message = '授权失效'
  else if (state.scenario === 'empty') message = '空目录'
  const content = message
    ? `<div class="pane-empty">${message}</div>`
    : entries
        .map(
          ([name, size, modified]) =>
            `<button class="pane-entry" data-action="${name === 'chapter-1' ? `folder-${side}` : 'file'}" data-name="${name}" data-size="${size}" data-modified="${modified}" title="${name}"><span class="pane-icon ${name === 'chapter-1' ? '' : 'document'}">${name === 'chapter-1' ? icon('folder') : '▤'}</span><span class="pane-text"><strong>${name}</strong><small>${size}</small><time>${modified}</time></span></button>`,
        )
        .join('')
  return `<section class="file-pane" aria-label="${computer ? '电脑' : '手机'}文件"><div class="pane-head"><div><strong>${escapeHtml(details.name)}</strong><span class="tag">${role}</span></div><small title="${escapeHtml(details.directory)}">${escapeHtml(details.directory || '未设置目录')}${path.length ? ' / chapter-1' : ''}</small></div><div class="pane-scroll">${path.length && !message ? button('‹ 上一级', `up-${side}`, 'pane-up') : ''}${content}</div></section>`
}
function transferBlocked() {
  return (
    !isConnected(selectedPeer()) ||
    !game().directories[state.platform] ||
    !game().remoteDirectories[selectedPeer()?.id] ||
    state.scenario === 'permission' ||
    isTaskRunning()
  )
}
function renderTransfer() {
  header('传输存档', escapeHtml(game().name), 'games')
  const peer = selectedPeer()
  let hint = ''
  if (isTaskRunning()) hint = notice('已有传输进行中。') + button('查看任务', 'tasks', 'link')
  else if (!peer) hint = button('关联设备 ›', 'edit', 'link')
  else if (!isConnected(peer))
    hint = notice(`${escapeHtml(peer.name)} 未连接。`) + button('管理设备 ›', 'connection', 'link')
  else if (state.scenario === 'permission')
    hint = notice('本机目录授权已失效。') + button('目录设置 ›', 'edit', 'link')
  $('action').innerHTML =
    `<div class="action-bar">${button('预览本次变化', 'preview', 'primary', transferBlocked() ? 'disabled' : '')}</div>`
  return `${peerSelect()}${hint}<div class="dual-files">${filePane('computer')}${filePane('phone')}</div><div class="section-title compact-title"><h2>同步方向</h2></div><div class="segments direction">${button('电脑 → 手机', 'download', !state.upload ? 'active' : '')}${button('手机 → 电脑', 'upload', state.upload ? 'active' : '')}</div><div class="compact-options"><label class="compact-option"><span>删除目标端多出的文件</span><input id="delete-extra" type="checkbox" role="switch" ${state.removeExtra ? 'checked' : ''}/></label><label class="compact-option"><span>覆盖前备份</span><input id="backup" type="checkbox" role="switch" ${state.backup ? 'checked' : ''}/></label></div>${button('目录设置 ›', 'edit', 'link')}`
}
function renderPreview() {
  header(
    '确认本次变化',
    `${escapeHtml(game().name)} · ${escapeHtml(selectedPeer()?.name ?? '未选择设备')}`,
    'transfer',
  )
  const blocked = transferBlocked() || state.scenario === 'conflict'
  $('action').innerHTML =
    `<div class="action-bar">${button('返回调整', 'transfer')}${button(state.removeExtra ? '确认并开始同步' : '开始复制', 'start', 'primary', blocked ? 'disabled' : '')}</div>`
  return `<span class="tag">${state.upload ? '手机 → 电脑' : '电脑 → 手机'}</span>${mapping()}${blocked ? notice(state.scenario === 'conflict' ? '目标存在同名文件夹 save01.dat，请处理后重新预览。' : '请先确认设备连接、目录配置及当前任务。') : ''}<div class="summary-grid"><div><b>2</b><span>新增</span></div><div><b>1</b><span>覆盖</span></div><div class="${state.removeExtra ? 'danger' : ''}"><b>1</b><span>${state.removeExtra ? '删除' : '保留'}</span></div></div><div class="file-list">${[
    ['新增', 'save03.dat'],
    ['新增', 'save04.dat'],
    ['覆盖', 'save01.dat'],
    [state.removeExtra ? '删除' : '保留', 'old-save.dat'],
  ]
    .map(
      ([type, name]) =>
        `<div class="file-row"><span class="tag ${type === '删除' ? 'danger' : ''}">${type}</span><div class="grow"><div class="file-name">${name}</div><div class="file-meta">${type === '删除' || type === '保留' ? '仅存在于目标端' : '源端当前文件'}</div></div></div>`,
    )
    .join(
      '',
    )}</div><p class="muted">${state.backup ? '覆盖前创建备份。' : '本次覆盖前备份已关闭。'}</p>`
}
function renderTasks() {
  const task = state.task
  header(
    '传输详情',
    task ? `${escapeHtml(task.gameName)} · ${escapeHtml(task.peerName)}` : '',
    'games',
  )
  if (!task) return empty('暂无传输任务', '', 'transfer', '传输存档')
  const unknown = state.scenario === 'unknown'
  const cleanup = state.scenario === 'cleanup'
  const title = unknown
    ? '结果待确认'
    : cleanup
      ? '文件已写入，清理未完成'
      : task.status === 'done'
        ? '目标写入成功'
        : task.status === 'cancelled'
          ? '已取消'
          : '正在传输'
  return `<div class="card"><span class="tag">${task.upload ? '手机 → 电脑' : '电脑 → 手机'}</span><h2 style="margin-top:18px">${title}</h2>${mapping(task)}${!unknown && !cleanup && task.status === 'running' ? '<div class="large">62<span style="font-size:18px">%</span></div><div class="progress"><span></span></div><p>传输阶段 · 1.24 / 2 MiB</p>' : ''}${unknown ? notice('已发送，暂时没拿到接收端结果。恢复连接后查询这次任务。') : cleanup ? notice('仍有临时文件未清理。') : ''}<div class="section-title">${unknown ? button('重新查询', 'query', 'primary') : cleanup ? button('重试清理', 'cleanup', 'primary') : task.status === 'running' ? button('取消传输', 'cancel', 'link danger') + button('演示完成', 'finish', 'link') : button('返回游戏', 'games', 'primary')}</div></div><div class="section-title"><h2>文件结果</h2></div><div class="file-list">${['save03.dat', 'save04.dat', 'save01.dat'].map((name) => `<div class="file-row"><div><div class="file-name">${name}</div><div class="file-meta">${unknown ? '等待接收端确认' : cleanup || task.status === 'done' ? '写入成功' : task.status === 'cancelled' ? '未尝试 · 已取消' : '等待写入'}</div></div></div>`).join('')}</div>`
}
function renderEdit() {
  header('游戏目录', escapeHtml(game().name), 'games')
  const linked = linkedPeers()
  const available = savedPeers().filter((item) => !linked.includes(item))
  return `<div class="card"><label class="field">游戏名称<input id="game-name" value="${escapeHtml(game().name)}" /></label></div><div class="card"><h2>本机${ownLabel()}目录</h2><p>${escapeHtml(game().directories[state.platform] || '未选择目录')}</p>${button('选择目录', 'pick-local', 'link')}${state.scenario === 'permission' ? notice('目录授权已失效，请重新选择。') : ''}</div><div class="section-title"><h2>已关联设备</h2><span>${linked.length} 台</span></div><div class="linked-list">${linked.map((item) => `<div class="linked-device"><div class="grow"><strong>${escapeHtml(item.name)}</strong><p>${escapeHtml(game().remoteDirectories[item.id] || '未设置目录')}</p></div>${button('解除', 'unlink-device', 'link', `data-device="${item.id}" ${isDeviceBusy(item.id) ? 'disabled' : ''}`)}</div>`).join('') || '<p class="muted">尚未关联设备</p>'}</div>${available.length ? `<label class="field">关联设备<select id="link-device" aria-label="关联设备"><option value="">选择已保存的设备</option>${available.map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('')}</select></label>` : ''}${button('管理设备 ›', 'connection', 'link')}`
}
function renderRestore() {
  header('备份与恢复', `${escapeHtml(game().name)} · 本机${ownLabel()}`, 'games')
  return `${state.restoreStatus === 'complete' ? notice('恢复完成 · 2 个文件') : ''}<div class="card"><div class="detail-line"><span>恢复到</span>${escapeHtml(game().directories[state.platform] || '未选择目录')}</div></div><div class="backup-list">${['2026-10-26 22:10', '2026-10-25 19:42', '2026-10-24 09:18'].map((date) => `<button class="backup-item ${state.backupChoice === date ? 'chosen' : ''}" data-action="choose-backup" data-backup="${date}"><strong>${date}</strong><small>覆盖前备份 · 2 个文件</small></button>`).join('')}</div>${state.backupChoice ? `<div class="card restore-review" id="restore-review"><h2>恢复预览</h2><div class="detail-line"><span>备份</span>${state.backupChoice}</div><div class="detail-line"><span>目标</span>${escapeHtml(game().directories[state.platform] || '未选择目录')}</div><div class="file-list"><div class="file-row"><span class="tag">覆盖</span><span>save01.dat</span></div><div class="file-row"><span class="tag">新增</span><span>save02.dat</span></div></div>${button('确认恢复', 'restore-confirm', 'primary', !game().directories[state.platform] || isTaskRunning() ? 'disabled' : '')}</div>` : ''}`
}
function renderSettings() {
  header('设置')
  return `<div class="card"><h2>外观</h2><div class="detail-line"><span>主题</span>跟随系统</div></div><div class="card"><h2>帮助</h2>${button('连接不上设备 ›', 'help', 'link')}<br/>${button('目录授权问题 ›', 'permission', 'link')}</div><div class="card"><h2>存档同步</h2><p>版本 0.1.0</p></div>`
}
function renderSheet() {
  $('sheet')?.remove()
  if (!state.sheet) return
  const sheet = document.createElement('div')
  sheet.id = 'sheet'
  sheet.className = 'sheet-overlay'
  sheet.innerHTML = `<button class="sheet-backdrop" data-action="close-sheet" aria-label="关闭游戏操作面板"></button><section class="game-sheet" role="dialog" aria-modal="true" aria-label="游戏操作"><div class="sheet-handle"></div><div class="row between"><h2>${escapeHtml(game().name)}</h2>${button('×', 'close-sheet', 'link', 'aria-label="关闭"')}</div><button class="sheet-main" data-action="transfer">${icon('transfer')}<div class="grow"><strong>传输存档</strong></div><span>›</span></button><div class="sheet-grid">${button('目录设置 ›', 'edit')}${button('备份与恢复 ›', 'restore')}${button('本次传输 ›', 'tasks')}${button('移除游戏', 'remove-game', 'button danger')}</div></section>`
  $('device').append(sheet)
  sheet.querySelector('[aria-label="关闭"]').focus()
}
function render() {
  $('device').className = `device ${state.platform} ${state.theme}`
  $('scene').value = state.page
  const active = ['connection', 'device', 'settings'].includes(state.page)
    ? state.page === 'device'
      ? 'connection'
      : state.page
    : 'games'
  const nav = NAV.map(
    ([page, name, label]) =>
      `<button class="nav-item ${active === page ? 'active' : ''}" data-action="${page}" ${active === page ? 'aria-current="page"' : ''}>${icon(name)}<span>${label}</span></button>`,
  ).join('')
  $('sidebar').innerHTML =
    `<div class="brand"><span class="brand-mark">⇄</span>存档同步</div>${nav}<div class="sidebar-footer">版本 0.1.0</div>`
  $('bottom-nav').innerHTML = nav
  $('action').innerHTML = ''
  const views = {
    games: renderGames,
    connection: renderConnection,
    device: renderDevice,
    transfer: renderTransfer,
    preview: renderPreview,
    tasks: renderTasks,
    edit: renderEdit,
    restore: renderRestore,
    settings: renderSettings,
  }
  $('content').innerHTML = views[state.page]()
  $('note-title').textContent = NOTES[state.page][0]
  $('note-body').textContent = NOTES[state.page][1]
  renderSheet()
}
function showDialog(title, text, confirmAction) {
  $('dialog-content').replaceChildren()
  const heading = document.createElement('h2')
  heading.textContent = title
  const paragraph = document.createElement('p')
  paragraph.textContent = text
  $('dialog-content').append(heading, paragraph)
  if (confirmAction) {
    const confirm = document.createElement('button')
    confirm.className = 'primary'
    confirm.dataset.action = confirmAction
    confirm.textContent = '确认'
    $('dialog-content').append(confirm)
  }
  $('dialog').showModal()
}
function beginTask() {
  if (transferBlocked()) return
  const peer = selectedPeer()
  state.task = {
    status: 'running',
    gameId: game().id,
    gameName: game().name,
    peerId: peer.id,
    peerName: peer.name,
    platform: state.platform,
    upload: state.upload,
    computer: { ...endpoint('computer') },
    phone: { ...endpoint('phone') },
  }
  state.page = 'tasks'
}
document.addEventListener('click', (event) => {
  const control = event.target.closest('[data-action]')
  if (!control) return
  const action = control.dataset.action
  if (NOTES[action]) {
    state.page = action
    state.sheet = false
  } else if (action === 'game') {
    state.gameId = control.dataset.game
    state.sheet = true
    state.backupChoice = ''
    state.restoreStatus = 'idle'
    resetBrowse()
  } else if (action === 'close-sheet') state.sheet = false
  else if (action === 'upload' || action === 'download') state.upload = action === 'upload'
  else if (action === 'folder-computer') state.computerPath.push('chapter-1')
  else if (action === 'folder-phone') state.phonePath.push('chapter-1')
  else if (action === 'up-computer') state.computerPath.pop()
  else if (action === 'up-phone') state.phonePath.pop()
  else if (action === 'choose-backup') {
    state.backupChoice = control.dataset.backup
    state.restoreStatus = 'idle'
  } else if (action === 'restore-confirm') {
    showDialog(
      '确认恢复备份',
      `恢复到本机${ownLabel()}的 ${game().directories[state.platform]}：覆盖 save01.dat，新增 save02.dat。`,
      'confirm-restore',
    )
    return
  } else if (action === 'confirm-restore') {
    $('dialog').close()
    state.restoreStatus = 'complete'
  } else if (action === 'add-game') {
    const id = `game-${state.games.length + 1}`
    state.games.push({
      id,
      name: '新游戏',
      word: 'SAVE DATA',
      color: '',
      directories: { mobile: '', desktop: '' },
      linked: { mobile: [], desktop: [] },
      selected: { mobile: '', desktop: '' },
      remoteDirectories: {},
    })
    state.gameId = id
    state.page = 'edit'
  } else if (action === 'manage-device') {
    state.editingDeviceId = control.dataset.device
    state.page = 'device'
  } else if (action === 'add-device') {
    if (state.platform === 'desktop') {
      showDialog('添加手机', '在手机的设备页添加此电脑地址。手机连接后，这里会显示设备卡片。')
      return
    }
    state.editingDeviceId = null
    state.page = 'device'
  } else if (action === 'save-device') {
    const name = $('device-name').value.trim()
    const address =
      state.platform === 'mobile'
        ? $('device-address')
            .value.trim()
            .replace(/^http:\/\//, '')
            .replace(/\/$/, '')
        : ''
    if (
      !name ||
      (state.platform === 'mobile' &&
        (!/^[a-zA-Z0-9.-]+:\d{1,5}$/.test(address) ||
          Number(address.split(':').at(-1)) > 65535 ||
          Number(address.split(':').at(-1)) < 1))
    ) {
      showDialog('检查设备信息', '填写设备名称和电脑显示的 IP:端口。')
      return
    }
    const item = state.devices.find((value) => value.id === state.editingDeviceId)
    if (state.platform === 'desktop' && !item) return
    if (item && isDeviceBusy(item.id) && state.platform === 'mobile' && item.address !== address) {
      showDialog('传输进行中', '结束当前传输后再修改设备地址。')
      return
    }
    if (item) {
      item.name = name
      if (state.platform === 'mobile' && item.address !== address) {
        item.address = address
        item.connected = false
      }
    } else
      state.devices.push({
        id: `pc-${Date.now()}`,
        type: 'desktop',
        name,
        address,
        connected: false,
      })
    state.page = 'connection'
  } else if (action === 'connect-device' || action === 'disconnect-device') {
    const item = state.devices.find((value) => value.id === control.dataset.device)
    if (isDeviceBusy(item.id)) return
    item.connected = action === 'connect-device'
    if (item.connected) {
      state.scenario = 'normal'
      $('scenario').value = 'normal'
    }
  } else if (action === 'forget-device') {
    showDialog(
      '移除设备',
      '移除这个设备及其游戏关联。本机游戏目录和存档文件保留。',
      'confirm-forget',
    )
    return
  } else if (action === 'confirm-forget') {
    const id = state.editingDeviceId
    if (isDeviceBusy(id)) return
    state.devices = state.devices.filter((item) => item.id !== id)
    for (const item of state.games)
      for (const platform of ['mobile', 'desktop']) {
        item.linked[platform] = item.linked[platform].filter((value) => value !== id)
        if (item.selected[platform] === id) item.selected[platform] = ''
      }
    $('dialog').close()
    state.page = 'connection'
  } else if (action === 'unlink-device') {
    const id = control.dataset.device
    if (isDeviceBusy(id)) return
    game().linked[state.platform] = game().linked[state.platform].filter((value) => value !== id)
    if (game().selected[state.platform] === id) game().selected[state.platform] = ''
  } else if (action === 'pick-local') {
    if (isTaskRunning() && state.task.gameId === game().id) {
      showDialog('传输进行中', '结束当前传输后再更换这个游戏的目录。')
      return
    }
    showDialog('选择本机目录', '正式应用在本机打开系统目录选择器；选择成功后保存到这个游戏。')
    return
  } else if (action === 'start') {
    if (state.removeExtra) {
      showDialog(
        '确认删除目标端文件',
        `本次对端：${selectedPeer().name}。将删除目标端 old-save.dat，并新增 2 项、覆盖 1 项。`,
        'confirm-start',
      )
      return
    }
    beginTask()
  } else if (action === 'confirm-start') {
    $('dialog').close()
    beginTask()
  } else if (action === 'finish' && state.task) state.task.status = 'done'
  else if (action === 'cancel' && state.task) state.task.status = 'cancelled'
  else if (action === 'service') {
    if (state.serviceRunning && isTaskRunning()) {
      showDialog('停止本机服务', '将断开所有手机连接，并取消当前传输。', 'confirm-stop')
      return
    }
    state.serviceRunning = !state.serviceRunning
    if (!state.serviceRunning)
      for (const item of state.devices.filter((value) => value.type === 'mobile'))
        item.connected = false
  } else if (action === 'confirm-stop') {
    state.serviceRunning = false
    state.task.status = 'cancelled'
    for (const item of savedPeers()) item.connected = false
    $('dialog').close()
  } else if (action === 'file') {
    showDialog(control.dataset.name, `${control.dataset.size} · 修改于 ${control.dataset.modified}`)
    return
  } else {
    const messages = {
      query: ['查询原任务', '恢复连接后查询原任务，仍无回执时保留“结果待确认”。'],
      cleanup: ['重试清理', '在报告清理失败的设备上重试，成功后再开始下一次传输。'],
      help: ['检查连接', '确认两端在同一局域网，电脑服务已启动，手机填写电脑当前显示的地址。'],
      permission: ['重新选择目录', '进入对应游戏的目录设置，通过系统选择器重新授权。'],
      'remove-game': ['移除游戏配置', '确认后移除游戏配置和设备关联，保留各设备的存档文件。'],
    }
    if (messages[action]) showDialog(...messages[action])
  }
  render()
})
document.addEventListener('change', (event) => {
  const id = event.target.id
  if (['platform', 'theme', 'scenario'].includes(id)) {
    state[id] = event.target.value
    if (id === 'platform') {
      resetBrowse()
      state.backupChoice = ''
      state.restoreStatus = 'idle'
      if (state.page === 'device') state.page = 'connection'
    }
  } else if (id === 'scene') {
    state.page = event.target.value
    state.sheet = false
  } else if (id === 'delete-extra') state.removeExtra = event.target.checked
  else if (id === 'backup') state.backup = event.target.checked
  else if (id === 'peer-select') {
    game().selected[state.platform] = event.target.value
    resetBrowse()
  } else if (id === 'link-device') {
    const value = event.target.value
    if (value) game().linked[state.platform].push(value)
  } else if (id === 'game-name') {
    const value = event.target.value.trim()
    if (!value) {
      showDialog('填写游戏名称', '游戏名称不能为空。')
      event.target.value = game().name
      return
    }
    game().name = value
    return
  } else return
  render()
})
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.sheet) {
    state.sheet = false
    render()
  }
  if (event.key === 'Tab' && state.sheet) {
    const controls = [...$('sheet').querySelectorAll('.game-sheet button')]
    const first = controls[0]
    const last = controls.at(-1)
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }
})
render()
